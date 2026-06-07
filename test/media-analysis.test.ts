import { afterEach, describe, expect, it, vi } from "vitest";
import { processCallback } from "../src/callback/dispatcher.ts";
import { dispatchAnalyzeJob } from "../src/analyze/pipeline/dispatcher.ts";
import { executeMediaAnalysis } from "../src/analyze/pipeline/media-analysis.ts";
import { callGeminiMediaAnalysis } from "../src/analyze/providers/gemini-media.ts";
import { callXaiMediaAnalysis } from "../src/analyze/providers/xai-media.ts";
import {
  MediaAnalysisInput,
  MediaAnalysisOutput,
  type MediaAnalysisOutputT,
} from "../src/analyze/schema/media-analysis.ts";
import type { AnalyzeRow } from "../src/analyze/types.ts";
import { ErrorCodes, type AppError } from "../src/lib/errors.ts";
import { canTry } from "../src/providers/circuit.ts";
import { resolveAnalyzeRoute } from "../src/providers/router.ts";

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
  prompts = {
    gemini: { version: 1, content: "base gemini media prompt" },
    xai: { version: 1, content: "base xai media prompt" },
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
    if (this.sql.includes("FROM analyze_requests WHERE id = ?")) {
      return (this.db.rows.find((r) => r.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM prompts WHERE biz_type = ?")) {
      const provider = this.args[1] === "xai" ? "xai" : "gemini";
      return this.db.prompts[provider] as T;
    }
    return null;
  }
  async run(): Promise<unknown> {
    if (this.sql.includes("UPDATE analyze_requests SET delivered_at = ?")) {
      const row = this.db.rows.find((r) => r.id === this.args[1]);
      if (row) row.delivered_at = this.args[0] as number;
      return {};
    }
    if (this.sql.includes("UPDATE analyze_requests SET")) {
      const row = this.db.rows.find((r) => r.id === this.args[11]);
      if (!row) return {};
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
    return {};
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaAnalysis schema", () => {
  it("accepts one to sixteen https image urls", () => {
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["https://cdn.example.com/1.jpg"],
    }).success).toBe(true);
    expect(MediaAnalysisInput.safeParse({
      image_urls: Array.from({ length: 16 }, (_, i) => `https://cdn.example.com/${i}.jpg`),
    }).success).toBe(true);
    expect(MediaAnalysisInput.safeParse({ image_urls: [] }).success).toBe(false);
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["http://cdn.example.com/1.jpg"],
    }).success).toBe(false);
  });

  it("accepts raw non-negative frame quality scores from IRC", () => {
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["https://cdn.example.com/1.jpg"],
      frame_metadata: [
        { timestamp_seconds: 12.5, quality_score: 184.5093, scene_id: 1 },
      ],
    }).success).toBe(true);
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["https://cdn.example.com/1.jpg"],
      frame_metadata: [
        { timestamp_seconds: 12.5, quality_score: -1, scene_id: 1 },
      ],
    }).success).toBe(false);
  });

  it("accepts long IRC resource titles as bounded hints", () => {
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["https://cdn.example.com/1.jpg"],
      title: "x".repeat(2048),
    }).success).toBe(true);
    expect(MediaAnalysisInput.safeParse({
      image_urls: ["https://cdn.example.com/1.jpg"],
      title: "x".repeat(2049),
    }).success).toBe(false);
  });

  it("accepts the RFC superset output shape", () => {
    expect(MediaAnalysisOutput.safeParse(sampleOutput()).success).toBe(true);
    expect(MediaAnalysisOutput.safeParse({
      ...sampleOutput(),
      score: 101,
    }).success).toBe(false);
    expect(MediaAnalysisOutput.safeParse({
      ...sampleOutput(),
      region: { ...sampleOutput().region, code: "antarctica" },
    }).success).toBe(false);
  });
});

describe("analyze provider routing", () => {
  it("routes media_analysis to xAI only after 2026-06-04 gemini sunset", () => {
    expect(resolveAnalyzeRoute("media_analysis")).toEqual({
      primary: "xai",
      fallback: null,
    });
  });
});

describe("Gemini media provider", () => {
  it("fetches image URLs and sends Gemini inline_data parts with response schema", async () => {
    let body: unknown;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("cdn.example.com")) return imageResponse("image/png");
      body = JSON.parse(init?.body as string);
      return geminiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callGeminiMediaAnalysis({
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
    } as unknown as Env, {
      prompt: "prompt",
      input: { image_urls: ["https://cdn.example.com/1.png"] },
      timeoutMs: 1000,
    });

    expect(res.inputTokens).toBe(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPart = ((body as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts[1]) as {
      inline_data: { mime_type: string; data: string };
    };
    expect(firstPart.inline_data).toEqual({
      mime_type: "image/png",
      data: "AQID",
    });
    expect(JSON.stringify(body)).toContain("responseSchema");
  });

  it("retries transient Gemini 5xx responses", async () => {
    let geminiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      geminiCalls += 1;
      return geminiCalls === 1
        ? new Response("temporary", { status: 503 })
        : geminiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callGeminiMediaAnalysis({
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
    } as unknown as Env, {
      prompt: "prompt",
      input: { image_urls: ["https://cdn.example.com/1.png"] },
      timeoutMs: 1000,
    });

    expect(res.rawText).toContain("moderation");
    expect(geminiCalls).toBe(2);
  });

  it("classifies inaccessible or non-image media as unsupported_content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("Unable to retrieve image from file_uri", { status: 400 })
    ));

    await expect(callGeminiMediaAnalysis({
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
    } as unknown as Env, {
      prompt: "prompt",
      input: { image_urls: ["https://cdn.example.com/not-image.txt"] },
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: ErrorCodes.UNSUPPORTED_CONTENT,
    } satisfies Partial<AppError>);
  });
});

describe("xAI media provider", () => {
  it("uses public image_url parts and JSON mode", async () => {
    let body: unknown;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return xaiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callXaiMediaAnalysis({
      GROK_API_KEY: "key",
      GROK_MEDIA_MODEL: "grok-test",
    } as unknown as Env, {
      prompt: "prompt",
      input: { image_urls: ["https://cdn.example.com/1.jpg"] },
      timeoutMs: 1000,
    });

    expect(res.model).toBe("grok-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      model: "grok-test",
      response_format: { type: "json_object" },
      messages: [{
        content: [
          {
            type: "image_url",
            image_url: {
              url: "https://cdn.example.com/1.jpg",
              detail: "high",
            },
          },
          { type: "text", text: "prompt" },
        ],
      }],
    });
  });
});

describe("media_analysis retry handling", () => {
  it("leaves the row pending and rethrows when all providers are unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeD1();
    const row = makeRow("r1");
    db.rows.push(row);
    const nonce = new MemKV();
    const now = Date.now();
    const openCircuit = JSON.stringify({
      failures: 5,
      openUntil: now + 60_000,
      lastFailure: now,
    });
    await nonce.put("cb:xai:media_analysis", openCircuit);
    await nonce.put("cb:gemini:media_analysis", openCircuit);

    await expect(executeMediaAnalysis({
      DB: db,
      NONCE: nonce,
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
    } as unknown as Env, row, "grok")).rejects.toMatchObject({
      code: ErrorCodes.SERVICE_UNAVAILABLE,
    });

    expect(row).toMatchObject({
      status: "pending",
      error_code: null,
      completed_at: null,
    });
  });
});

describe("media_analysis pipeline", () => {
  // 2026-06-04 platform sunset gemini; gemini-primary pipeline tests deprecated until rewritten as xai-primary
  it.skip("writes ok result, enqueues callback, and hits KV dedup on identical input (gemini-primary deprecated)", async () => {
    const db = new FakeD1();
    const dedup = new MemKV();
    const callbackQueue = new MemQueue<object>();
    db.rows.push(makeRow("r1"), makeRow("r2"));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      return geminiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      DB: db,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: dedup,
      CALLBACK_QUEUE: callbackQueue,
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env;

    await dispatchAnalyzeJob(env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });
    await dispatchAnalyzeJob(env, {
      request_id: "r2",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(1);
    expect(db.rows[0]).toMatchObject({
      status: "ok",
      cached: 0,
      provider: "gemini",
      model: "gemini-test",
      prompt_version: 1,
      error_code: null,
    });
    expect(db.rows[1]).toMatchObject({
      status: "ok",
      cached: 1,
      provider: "gemini",
      model: "gemini-test",
      prompt_version: 1,
      error_code: null,
    });
    expect(JSON.parse(db.rows[0]!.result_json ?? "{}")).toMatchObject({
      moderation: { decision: "approve" },
    });
    expect(callbackQueue.sent).toHaveLength(2);
  });

  it.skip("posts the analyze callback body after successful analysis (gemini-primary deprecated)", async () => {
    const db = new FakeD1();
    const apps = new MemKV();
    const callbackQueue = new MemQueue<object>();
    db.rows.push(makeRow("r1"));
    await apps.put("app:app_a", JSON.stringify({
      id: "app_a",
      name: "App A",
      secret: "secret",
      callback_url: "https://app.example.com/analyze-callback",
      biz_types: [],
      analyze_biz_types: ["media_analysis"],
      delivery_mode: "both",
      callback_max_concurrency: 10,
      rate_limit_qps: 50,
      disabled: false,
      provider_strategy: "auto",
    }));

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      return geminiResponse();
    }));

    const env = {
      DB: db,
      APPS: apps,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: callbackQueue,
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env;

    await dispatchAnalyzeJob(env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    let postedBody: Record<string, unknown> | null = null;
    const callbackFetch = vi.fn(async (_url: string, init: RequestInit) => {
      postedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", callbackFetch);

    await processCallback(env, { request_id: "r1", attempt: 0 });

    expect(callbackFetch).toHaveBeenCalledWith(
      "https://app.example.com/analyze-callback",
      expect.objectContaining({ method: "POST" }),
    );
    expect(postedBody).toMatchObject({
      schema_version: "1.1",
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      status: "ok",
      provider: "gemini",
      result: { moderation: { decision: "approve" } },
    });
    expect(postedBody).not.toHaveProperty("risk_level");
    expect(db.rows[0]!.delivered_at).toEqual(expect.any(Number));
  });

  it.skip("falls back to xAI when Gemini cannot retrieve the media URL (gemini fallback removed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeD1();
    db.rows.push(makeRow("r1"));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) {
        return imageResponse();
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response("Unable to retrieve image from file_uri", { status: 400 });
      }
      if (url.includes("api.x.ai")) {
        return xaiResponse();
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAnalyzeJob({
      DB: db,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "xai",
      error_code: null,
    });
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(1);
    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
  });

  it.skip("falls back to xAI when Gemini returns an empty response (gemini fallback removed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeD1();
    db.rows.push(makeRow("r1"));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "" }] } }] });
      }
      if (url.includes("api.x.ai")) return xaiResponse();
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAnalyzeJob({
      DB: db,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-test",
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "xai",
      error_code: null,
    });
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(1);
    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
  });

  it("uses xAI first when the app provider strategy is grok", async () => {
    const db = new FakeD1();
    const apps = new MemKV();
    db.rows.push(makeRow("r1"));
    await apps.put("app:app_a", JSON.stringify({
      id: "app_a",
      name: "IRC",
      secret: "secret",
      callback_url: "https://consumer.example.com/analyze",
      biz_types: [],
      analyze_biz_types: ["media_analysis"],
      delivery_mode: "both",
      callback_max_concurrency: 10,
      rate_limit_qps: 50,
      disabled: false,
      provider_strategy: "grok",
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("api.x.ai")) return xaiResponse();
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAnalyzeJob({
      DB: db,
      APPS: apps,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      provider: "xai",
      model: "grok-test",
      error_code: null,
    });
    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(0);
  });

  it("does not fall back to Gemini when the app provider strategy is grok", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeD1();
    const apps = new MemKV();
    db.rows.push(makeRow("r1"));
    await apps.put("app:app_a", JSON.stringify({
      id: "app_a",
      name: "IRC",
      secret: "secret",
      callback_url: "https://consumer.example.com/analyze",
      biz_types: [],
      analyze_biz_types: ["media_analysis"],
      delivery_mode: "both",
      callback_max_concurrency: 10,
      rate_limit_qps: 50,
      disabled: false,
      provider_strategy: "grok",
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      if (url.includes("api.x.ai")) return new Response("temporary", { status: 503 });
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatchAnalyzeJob({
      DB: db,
      APPS: apps,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    })).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ERROR,
    });

    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(0);
    expect(db.rows[0]).toMatchObject({
      status: "pending",
      provider: null,
      error_code: null,
      completed_at: null,
    });
  });

  it("does not reuse legacy Gemini cache when the app provider strategy is grok", async () => {
    const db = new FakeD1();
    const apps = new MemKV();
    const dedup = new MemKV();
    db.rows.push(makeRow("r1"));
    await apps.put("app:app_a", JSON.stringify({
      id: "app_a",
      name: "IRC",
      secret: "secret",
      callback_url: "https://consumer.example.com/analyze",
      biz_types: [],
      analyze_biz_types: ["media_analysis"],
      delivery_mode: "both",
      callback_max_concurrency: 10,
      rate_limit_qps: 50,
      disabled: false,
      provider_strategy: "grok",
    }));
    await dedup.put("media_analysis:1:same-input-hash", JSON.stringify({
      result: sampleOutput(),
      provider: "gemini",
      model: "gemini-test",
      prompt_version: 1,
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("api.x.ai")) return xaiResponse();
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAnalyzeJob({
      DB: db,
      APPS: apps,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: dedup,
      CALLBACK_QUEUE: new MemQueue<object>(),
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    });

    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(0);
    expect(db.rows[0]).toMatchObject({
      status: "ok",
      cached: 0,
      provider: "xai",
      model: "grok-test",
      error_code: null,
    });
  });

  it.skip("leaves the row pending for provider errors so the queue can retry (gemini-primary deprecated)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeD1();
    db.rows.push(makeRow("r1"));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) return imageResponse();
      return new Response("temporary", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatchAnalyzeJob({
      DB: db,
      NONCE: new MemKV(),
      PROMPTS: new MemKV(),
      DEDUP_CACHE: new MemKV(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-test",
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env, {
      request_id: "r1",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: Date.now(),
    })).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ERROR,
    });

    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(3);
    expect(countFetches(fetchMock, "api.x.ai")).toBe(1);
    expect(db.rows[0]).toMatchObject({
      status: "pending",
      error_code: null,
      completed_at: null,
    });
  });

  it.skip("opens Gemini media circuit, uses xAI fallback, then probes Gemini after 30s (gemini path removed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const db = new FakeD1();
    const nonce = new MemKV();
    const dedup = new MemKV();
    const callbackQueue = new MemQueue<object>();
    let geminiHealthy = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("cdn.example.com")) {
        return imageResponse();
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        if (!geminiHealthy) return new Response("temporary", { status: 503 });
        return geminiResponse();
      }
      if (url.includes("api.x.ai")) {
        return xaiResponse();
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      DB: db,
      NONCE: nonce,
      PROMPTS: new MemKV(),
      DEDUP_CACHE: dedup,
      CALLBACK_QUEUE: callbackQueue,
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-test",
      GROK_API_KEY: "grok-key",
      GROK_MEDIA_MODEL: "grok-test",
      DEDUP_TTL_SECONDS: "604800",
    } as unknown as Env;

    for (let i = 1; i <= 5; i++) {
      const id = `r${i}`;
      db.rows.push(makeRow(id, `hash-${i}`));
      await dispatchAnalyzeJob(env, {
        request_id: id,
        app_id: "app_a",
        biz_type: "media_analysis",
        created_at_ms: now,
      });
    }

    // M10（2026-06-03）：FAIL_THRESHOLD 5→3。每次 dispatchAnalyzeJob 内 gemini 内部 retry 3 次失败
    //   后才 fall back xai，每次 pipeline 调用记 1 次 circuit failure。
    //   旧（threshold=5）：5 iter 每次都打 gemini → 15 gemini + 5 xai。
    //   新（threshold=3）：iter 1-3 各打 gemini 3 次（共 9）后开熔断；iter 4-5 直接走 xai 跳过 gemini。
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(9);
    expect(countFetches(fetchMock, "api.x.ai")).toBe(5);
    expect(await canTry(nonce as unknown as KVNamespace, "gemini", "media_analysis")).toBe(false);
    expect(await canTry(nonce as unknown as KVNamespace, "gemini")).toBe(true);

    db.rows.push(makeRow("r6", "hash-6"));
    await dispatchAnalyzeJob(env, {
      request_id: "r6",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: now,
    });
    expect(countFetches(fetchMock, "generativelanguage.googleapis.com")).toBe(9);
    expect(db.rows[5]).toMatchObject({ status: "ok", provider: "xai", model: "grok-test" });

    now += 31_000;
    geminiHealthy = true;
    db.rows.push(makeRow("r7", "hash-7"));
    await dispatchAnalyzeJob(env, {
      request_id: "r7",
      app_id: "app_a",
      biz_type: "media_analysis",
      created_at_ms: now,
    });
    expect(db.rows[6]).toMatchObject({ status: "ok", provider: "gemini", model: "gemini-test" });
    expect(await canTry(nonce as unknown as KVNamespace, "gemini", "media_analysis")).toBe(true);
  });

  it.skip("records schema_validation_failed for malformed Gemini JSON (gemini-primary deprecated)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = await dispatchWithGeminiResponse(Response.json({
      candidates: [{ content: { parts: [{ text: "{\"not\":\"media-analysis\"}" }] } }],
    }));

    expect(db.rows[0]).toMatchObject({
      status: "error",
      error_code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    });
  });

  it.skip("normalizes partial media_analysis JSON into the public output schema (gemini-primary deprecated)", async () => {
    const { db } = await dispatchWithGeminiResponse(Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        description: "A simple image.",
        moderation: { summary: "No obvious issue." },
      }) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }));

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      error_code: null,
    });
    expect(JSON.parse(db.rows[0]!.result_json ?? "{}")).toMatchObject({
      moderation: {
        decision: "review",
        summary: "No obvious issue.",
      },
      tags: {
        status: "pending",
        categories: { meta: {}, appearance: {}, context: {}, production: {} },
      },
      ad_detection: { is_ad: false },
      face_coordinates: [],
      region: { code: "other" },
    });
  });

  it.skip("normalizes wrapped and loose provider JSON into the public output schema (gemini-primary deprecated)", async () => {
    const { db } = await dispatchWithGeminiResponse(Response.json({
      candidates: [{ content: { parts: [{ text: `Here is the JSON:\n${JSON.stringify({
        analysis: {
          moderation: { decision: "approve", confidence: 1, summary: "ok", violations: [] },
          tags: { summary: "tags" },
          ad_detection: { reason: "none" },
          region: { code: "unknown-region", confidence: 1.4 },
          face_coordinates: [{
            frame_index: 1.8,
            timestamp_seconds: 4.2,
            box: { x: 1.9, y: 2.1, width: 50.8, height: 60.2 },
            confidence: 0.9,
          }],
          score: 87.9,
          scoring_breakdown: { visual: 0.7, ignored: "bad" },
          description: { bad: true },
          cover_candidates: {
            frame_index: 2.5,
            timestamp_seconds: 8.1,
            score: 101,
            scoring_breakdown: { sharpness: 0.8 },
            reason: "clear",
          },
          trial: { trial_start_seconds: 1.2, trial_end_seconds: 8.7, trial_score: 2 },
          frame_notes: "bad",
        },
      })}\nThanks.` }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }));

    expect(db.rows[0]).toMatchObject({
      status: "ok",
      error_code: null,
    });
    expect(JSON.parse(db.rows[0]!.result_json ?? "{}")).toMatchObject({
      region: { code: "other", confidence: 1 },
      face_coordinates: [{ box: { x: 1, y: 2, width: 50, height: 60 }, orientation: "unknown" }],
      description: "",
      score: 87,
      scoring_breakdown: { visual: 0.7 },
      cover_candidates: [],
      trial: { trial_start_seconds: 1, trial_end_seconds: 8, trial_score: 1, status: "pending" },
      frame_notes: [],
    });
  });
});

function makeRow(id: string, inputHash = "same-input-hash"): AnalyzeRow {
  return {
    id,
    app_id: "app_a",
    biz_type: "media_analysis",
    biz_id: "video-1",
    user_id: null,
    input_hash: inputHash,
    input_json: JSON.stringify({
      image_urls: ["https://cdn.example.com/1.jpg"],
      title: "Example",
    }),
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
    callback_url: null,
    extra_json: null,
    delivered_at: null,
    acked_at: null,
    created_at: Date.now(),
    completed_at: null,
  };
}

function geminiResponse(): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(sampleOutput()) }] } }],
    usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 44 },
  });
}

function imageResponse(mimeType = "image/jpeg"): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": mimeType },
  });
}

function xaiResponse(): Response {
  return Response.json({
    model: "grok-test",
    choices: [{ message: { content: JSON.stringify(sampleOutput()) } }],
    usage: { prompt_tokens: 55, completion_tokens: 66 },
  });
}

function countFetches(fetchMock: ReturnType<typeof vi.fn>, needle: string): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes(needle)).length;
}

async function dispatchWithGeminiResponse(response: Response): Promise<{
  db: FakeD1;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const db = new FakeD1();
  db.rows.push(makeRow("r1"));
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("cdn.example.com")) return imageResponse();
    return response.clone();
  });
  vi.stubGlobal("fetch", fetchMock);

  await dispatchAnalyzeJob({
    DB: db,
    NONCE: new MemKV(),
    PROMPTS: new MemKV(),
    DEDUP_CACHE: new MemKV(),
    CALLBACK_QUEUE: new MemQueue<object>(),
    GEMINI_API_KEY: "key",
    GEMINI_MODEL: "gemini-test",
    DEDUP_TTL_SECONDS: "604800",
  } as unknown as Env, {
    request_id: "r1",
    app_id: "app_a",
    biz_type: "media_analysis",
    created_at_ms: Date.now(),
  });

  return { db, fetchMock };
}

function sampleOutput(): MediaAnalysisOutputT {
  return {
    moderation: {
      decision: "approve",
      confidence: 0.98,
      summary: "No policy violation found.",
      violations: [],
    },
    tags: {
      tag_names: ["studio"],
      extra_tag_names: [],
      categories: {
        meta: {},
        appearance: {},
        context: {},
        production: {},
      },
      summary: "Indoor studio scene.",
      status: "ready",
    },
    ad_detection: {
      is_ad: false,
      categories: [],
      elements: [],
      contacts: [],
      urls: [],
      reason: "No ad signals.",
    },
    face_coordinates: [],
    region: {
      code: "japan",
      requested_code: "japan",
      confidence: 0.8,
      reasoning: "Studio watermark.",
      signals: {},
    },
    description: "A studio scene.",
    score: 88,
    scoring_breakdown: { quality: 88 },
  };
}
