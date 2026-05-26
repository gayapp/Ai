import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminPromptsRouter } from "../src/routes/admin-prompts.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

describe("admin prompts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dry-runs media_analysis prompt input schema and preview without provider calls", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://local/admin/prompts/dry-run", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        biz_type: "media_analysis",
        provider: "xai",
        content: "Base prompt",
        samples: [JSON.stringify({
          image_urls: ["https://example.com/frame.jpg"],
          title: "Clip",
          frame_metadata: [{ timestamp_seconds: 0, quality_score: 0.9 }],
        })],
      }),
    }), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{
        dry_run_mode: string;
        input_schema_ok: boolean;
        image_count: number;
        prompt_preview: string;
      }>;
    };
    expect(body.results[0]).toMatchObject({
      dry_run_mode: "input_schema_and_prompt_preview",
      input_schema_ok: true,
      image_count: 1,
    });
    expect(body.results[0].prompt_preview).toContain("Since N=1");
  });

  it("serializes Gemini moderate dry-run samples to avoid quota bursts", async () => {
    const app = makeApp();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                status: "pass",
                risk_level: "safe",
                categories: [],
                reason: "ok",
              }),
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(new Request("http://local/admin/prompts/dry-run", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        biz_type: "comment",
        provider: "gemini",
        content: "Base prompt",
        samples: ["a", "b", "c"],
      }),
    }), makeEnv({ GEMINI_API_KEY: "gemini-key", GEMINI_MODEL: "gemini-test" }));

    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ schema_ok: boolean }> };
    expect(body.results).toHaveLength(3);
    expect(body.results.every((item) => item.schema_ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it("retries transient Gemini 429 responses during moderate dry-run", async () => {
    const app = makeApp();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                status: "pass",
                risk_level: "safe",
                categories: [],
                reason: "ok",
              }),
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }));

    const res = await app.fetch(new Request("http://local/admin/prompts/dry-run", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        biz_type: "comment",
        provider: "gemini",
        content: "Base prompt",
        samples: ["a"],
      }),
    }), makeEnv({ GEMINI_API_KEY: "gemini-key", GEMINI_MODEL: "gemini-test" }));

    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ error?: string; schema_ok?: boolean }> };
    expect(body.results[0]).toMatchObject({ schema_ok: true });
    expect(body.results[0].error).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("surfaces Gemini daily quota errors without repeated short retries", async () => {
    const app = makeApp();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 10000, model: gemini-2.5-flash. Please retry in 13h20m37s.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "48037s" }],
      },
    }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(new Request("http://local/admin/prompts/dry-run", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        biz_type: "comment",
        provider: "gemini",
        content: "Base prompt",
        samples: ["a"],
      }),
    }), makeEnv({ GEMINI_API_KEY: "gemini-key", GEMINI_MODEL: "gemini-test" }));

    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ error?: string }> };
    expect(body.results[0].error).toContain("generate_requests_per_model_per_day");
    expect(body.results[0].error).toContain("retry_in=13h20m37s");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/prompts", adminPromptsRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    ADMIN_TOKEN: "admin-token",
    ...extra,
  } as unknown as Env;
}
