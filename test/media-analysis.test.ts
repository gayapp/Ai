import { afterEach, describe, expect, it, vi } from "vitest";
import { processCallback } from "../src/callback/dispatcher.ts";
import { dispatchAnalyzeJob } from "../src/analyze/pipeline/dispatcher.ts";
import { callGeminiMediaAnalysis } from "../src/analyze/providers/gemini-media.ts";
import {
  MediaAnalysisInput,
  MediaAnalysisOutput,
  type MediaAnalysisOutputT,
} from "../src/analyze/schema/media-analysis.ts";
import type { AnalyzeRow } from "../src/analyze/types.ts";
import { ErrorCodes, type AppError } from "../src/lib/errors.ts";
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
  prompt = { version: 1, content: "base media prompt" };

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
      return this.db.prompt as T;
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
  it("uses Gemini primary and xAI fallback for media_analysis", () => {
    expect(resolveAnalyzeRoute("media_analysis")).toEqual({
      primary: "gemini",
      fallback: "xai",
    });
  });
});

describe("Gemini media provider", () => {
  it("uses Gemini file_data URL parts and response schema", async () => {
    let body: unknown;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sampleOutput()) }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
      });
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

    expect(res.inputTokens).toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstPart = ((body as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts[1]) as {
      file_data: { mime_type: string; file_uri: string };
    };
    expect(firstPart.file_data).toEqual({
      mime_type: "image/png",
      file_uri: "https://cdn.example.com/1.png",
    });
    expect(JSON.stringify(body)).toContain("responseSchema");
  });

  it("retries transient Gemini 5xx responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sampleOutput()) }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
      }));
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("media_analysis pipeline", () => {
  it("writes ok result, enqueues callback, and hits KV dedup on identical input", async () => {
    const db = new FakeD1();
    const dedup = new MemKV();
    const callbackQueue = new MemQueue<object>();
    db.rows.push(makeRow("r1"), makeRow("r2"));

    const fetchMock = vi.fn(async () => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(sampleOutput()) }] } }],
      usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 44 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      DB: db,
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("posts the analyze callback body after successful analysis", async () => {
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

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(sampleOutput()) }] } }],
      usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 44 },
    })));

    const env = {
      DB: db,
      APPS: apps,
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

  it("records unsupported_content for inaccessible or non-image URLs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = await dispatchWithGeminiResponse(
      new Response("Unable to retrieve image from file_uri", { status: 400 }),
    );

    expect(db.rows[0]).toMatchObject({
      status: "error",
      error_code: ErrorCodes.UNSUPPORTED_CONTENT,
    });
  });

  it("records provider_error for Gemini 5xx after retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, fetchMock } = await dispatchWithGeminiResponse(
      new Response("temporary", { status: 503 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(db.rows[0]).toMatchObject({
      status: "error",
      error_code: ErrorCodes.PROVIDER_ERROR,
    });
  });

  it("records schema_validation_failed for malformed Gemini JSON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = await dispatchWithGeminiResponse(Response.json({
      candidates: [{ content: { parts: [{ text: "{\"not\":\"media-analysis\"}" }] } }],
    }));

    expect(db.rows[0]).toMatchObject({
      status: "error",
      error_code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    });
  });
});

function makeRow(id: string): AnalyzeRow {
  return {
    id,
    app_id: "app_a",
    biz_type: "media_analysis",
    biz_id: "video-1",
    user_id: null,
    input_hash: "same-input-hash",
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

async function dispatchWithGeminiResponse(response: Response): Promise<{
  db: FakeD1;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const db = new FakeD1();
  db.rows.push(makeRow("r1"));
  const fetchMock = vi.fn(async () => response.clone());
  vi.stubGlobal("fetch", fetchMock);

  await dispatchAnalyzeJob({
    DB: db,
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
