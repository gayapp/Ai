import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeRouter } from "../src/routes/analyze.ts";
import { dispatchAnalyzeJob } from "../src/analyze/pipeline/dispatcher.ts";
import { callXaiTextJson } from "../src/analyze/providers/xai-text.ts";
import {
  MediaIntroInput,
  MediaIntroOutput,
  type MediaIntroOutputT,
} from "../src/analyze/schema/media-intro.ts";
import { hmacSha256Hex, sha256Hex } from "../src/lib/hash.ts";
import type { AnalyzeJob, AnalyzeRow } from "../src/analyze/types.ts";

class MemKV {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
  async delete(k: string): Promise<void> { this.m.delete(k); }
}

class MemQueue<T> {
  readonly sent: T[] = [];
  async send(msg: T): Promise<void> { this.sent.push(msg); }
}

class FakeD1 {
  readonly rows: AnalyzeRow[] = [];
  readonly app = {
    id: "app_intro",
    name: "Intro App",
    secret: "test-secret",
    callback_url: "https://consumer.example.com/analyze",
    biz_types: "[]",
    analyze_biz_types: JSON.stringify(["media_intro"]),
    delivery_mode: "both",
    callback_max_concurrency: 10,
    rate_limit_qps: 50,
    disabled: 0,
    provider_strategy: "auto",
    created_at: Date.now(),
  };
  prompts = {
    xai: { version: 1, content: "base xai intro prompt" },
    gemini: { version: 1, content: "base gemini intro prompt" },
  };

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(private readonly db: FakeD1, private readonly sql: string) {}
  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM apps WHERE id = ?")) {
      return this.args[0] === this.db.app.id ? this.db.app as T : null;
    }
    if (this.sql.includes("FROM analyze_requests WHERE id = ?")) {
      return (this.db.rows.find((r) => r.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM prompts WHERE biz_type = ?")) {
      const provider = this.args[1] === "gemini" ? "gemini" : "xai";
      return this.db.prompts[provider] as T;
    }
    return null;
  }
  async run(): Promise<unknown> {
    if (this.sql.includes("INSERT INTO analyze_requests")) {
      this.db.rows.push({
        id: this.args[0] as string,
        app_id: this.args[1] as string,
        biz_type: this.args[2] as string,
        biz_id: this.args[3] as string,
        user_id: this.args[4] as string | null,
        input_hash: this.args[5] as string,
        input_json: this.args[6] as string,
        mode: this.args[7] as string,
        cached: 0,
        status: "pending",
        delivery_mode: this.args[8] as string,
        callback_url: this.args[9] as string | null,
        extra_json: this.args[10] as string | null,
        prompt_version: null,
        provider: null,
        model: null,
        result_json: null,
        input_tokens: null,
        output_tokens: null,
        latency_ms: null,
        error_code: null,
        delivered_at: null,
        acked_at: null,
        created_at: this.args[11] as number,
        completed_at: null,
      });
    } else if (this.sql.includes("UPDATE analyze_requests SET mode = ?")) {
      const row = this.db.rows.find((r) => r.id === this.args[1]);
      if (row) row.mode = this.args[0] as string;
    } else if (this.sql.includes("UPDATE analyze_requests SET")) {
      const row = this.db.rows.find((r) => r.id === this.args[11]);
      if (row) {
        row.cached = this.args[0] as number;
        row.status = this.args[1] as string;
        row.result_json = this.args[2] as string | null;
        row.provider = this.args[3] as string | null;
        row.model = this.args[4] as string | null;
        row.prompt_version = this.args[5] as number | null;
        row.input_tokens = this.args[6] as number;
        row.output_tokens = this.args[7] as number;
        row.latency_ms = this.args[8] as number;
        row.error_code = this.args[9] as string | null;
        row.completed_at = this.args[10] as number;
      }
    }
    return {};
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaIntro schema", () => {
  it("validates input and output boundaries", () => {
    expect(MediaIntroInput.safeParse({ title: "Video title", max_length: 120 }).success).toBe(true);
    expect(MediaIntroInput.safeParse({ title: "x".repeat(2048), max_length: 120 }).success).toBe(true);
    expect(MediaIntroInput.safeParse({ title: "x".repeat(2049), max_length: 120 }).success).toBe(false);
    expect(MediaIntroInput.safeParse({ title: "", max_length: 120 }).success).toBe(false);
    expect(MediaIntroInput.safeParse({ title: "Video title", max_length: 20 }).success).toBe(false);
    expect(MediaIntroOutput.safeParse(sampleIntro()).success).toBe(true);
    expect(MediaIntroOutput.safeParse({
      ...sampleIntro(),
      title_suggestions: ["a", "b", "c", "d"],
    }).success).toBe(false);
  });
});

describe("xAI text provider", () => {
  it("uses JSON mode for media_intro generation", async () => {
    let body: unknown;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return xaiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callXaiTextJson({
      GROK_API_KEY: "key",
      GROK_MODEL: "grok-test",
    } as unknown as Env, {
      prompt: "prompt",
      timeoutMs: 1000,
    });

    expect(result.model).toBe("grok-test");
    expect(body).toMatchObject({
      model: "grok-test",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "prompt" }],
    });
  });
});

describe("media_intro route and pipeline", () => {
  it("returns sync result for auto mode when xAI completes quickly", async () => {
    const db = new FakeD1();
    const analyzeQueue = new MemQueue<AnalyzeJob>();
    vi.stubGlobal("fetch", vi.fn(async () => xaiResponse()));

    const body = JSON.stringify({
      biz_type: "media_intro",
      biz_id: "intro-1",
      input: { title: "Scene collection", tags: ["studio"], max_length: 120 },
    });
    const res = await analyzeRouter.fetch(new Request("http://local/v1/analyze", {
      method: "POST",
      headers: await signedHeaders(db.app.id, db.app.secret, body),
      body,
    }), makeEnv(db, analyzeQueue));

    expect(res.status).toBe(200);
    const payload = await res.json() as { cached: boolean; result: MediaIntroOutputT };
    expect(payload).toMatchObject({
      cached: false,
      result: { intro: sampleIntro().intro },
    });
    expect(analyzeQueue.sent).toHaveLength(0);
    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "xai",
      model: "grok-test",
    });
  });

  it("falls back to Gemini when xAI fails synchronously", async () => {
    const db = new FakeD1();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("api.x.ai")) return new Response("temporary", { status: 503 });
      return geminiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({
      biz_type: "media_intro",
      biz_id: "intro-fallback",
      input: { title: "Fallback title" },
    });
    const res = await analyzeRouter.fetch(new Request("http://local/v1/analyze", {
      method: "POST",
      headers: await signedHeaders(db.app.id, db.app.secret, body),
      body,
    }), makeEnv(db));

    expect(res.status).toBe(200);
    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "gemini",
      model: "gemini-test",
    });
  });

  it("downgrades auto mode to async when both providers time out", async () => {
    const db = new FakeD1();
    const analyzeQueue = new MemQueue<AnalyzeJob>();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw e;
    }));

    const body = JSON.stringify({
      biz_type: "media_intro",
      biz_id: "intro-slow",
      input: { title: "Slow title" },
    });
    const res = await analyzeRouter.fetch(new Request("http://local/v1/analyze", {
      method: "POST",
      headers: await signedHeaders(db.app.id, db.app.secret, body),
      body,
    }), makeEnv(db, analyzeQueue));

    expect(res.status).toBe(202);
    const accepted = await res.json() as { request_id: string; downgraded: boolean };
    expect(accepted.downgraded).toBe(true);
    expect(db.rows[0]).toMatchObject({
      id: accepted.request_id,
      mode: "auto-downgraded",
      status: "pending",
      completed_at: null,
    });
    expect(analyzeQueue.sent).toEqual([
      expect.objectContaining({
        request_id: accepted.request_id,
        biz_type: "media_intro",
      }),
    ]);
  });

  it("processes async media_intro from the analyze queue", async () => {
    const db = new FakeD1();
    vi.stubGlobal("fetch", vi.fn(async () => xaiResponse()));
    const env = makeEnv(db);
    db.rows.push(makeRow("queued-1"));

    await dispatchAnalyzeJob(env, {
      request_id: "queued-1",
      app_id: db.app.id,
      biz_type: "media_intro",
      created_at_ms: Date.now(),
    });

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "xai",
      model: "grok-test",
    });
    expect(JSON.parse(db.rows[0]!.result_json ?? "{}")).toMatchObject({
      intro: sampleIntro().intro,
    });
  });
});

function makeEnv(db: FakeD1, analyzeQueue = new MemQueue<AnalyzeJob>()): Env {
  return {
    DB: db,
    NONCE: new MemKV(),
    APPS: new MemKV(),
    PROMPTS: new MemKV(),
    DEDUP_CACHE: new MemKV(),
    ANALYZE_QUEUE: analyzeQueue,
    CALLBACK_QUEUE: new MemQueue<object>(),
    DEFAULT_RATE_LIMIT_QPS: "50",
    SYNC_TIMEOUT_MS: "1000",
    DEDUP_TTL_SECONDS: "604800",
    GROK_API_KEY: "grok-key",
    GROK_MODEL: "grok-test",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-test",
  } as unknown as Env;
}

function makeRow(id: string): AnalyzeRow {
  return {
    id,
    app_id: "app_intro",
    biz_type: "media_intro",
    biz_id: "intro-queued",
    user_id: null,
    input_hash: "queued-hash",
    input_json: JSON.stringify({ title: "Queued title" }),
    prompt_version: null,
    provider: null,
    model: null,
    mode: "async",
    cached: 0,
    status: "pending",
    result_json: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    error_code: null,
    delivery_mode: "both",
    callback_url: "https://consumer.example.com/analyze",
    extra_json: null,
    delivered_at: null,
    acked_at: null,
    created_at: Date.now(),
    completed_at: null,
  };
}

function sampleIntro(): MediaIntroOutputT {
  return {
    intro: "A concise studio-focused introduction for the selected video.",
    title_suggestions: ["Studio Highlights"],
    beats: [{ timestamp_seconds: 12, summary: "Opening scene" }],
  };
}

function xaiResponse(): Response {
  return Response.json({
    model: "grok-test",
    choices: [{ message: { content: JSON.stringify(sampleIntro()) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
}

function geminiResponse(): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(sampleIntro()) }] } }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
  });
}

async function signedHeaders(
  appId: string,
  secret: string,
  body: string,
): Promise<Headers> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = `0123456789abcdef${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
  const bodyHash = await sha256Hex(body);
  const sig = await hmacSha256Hex(secret, `${ts}\n${nonce}\n${bodyHash}`);
  return new Headers({
    "content-type": "application/json",
    "x-app-id": appId,
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-signature": sig,
  });
}
