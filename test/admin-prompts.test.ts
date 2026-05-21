import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminPromptsRouter } from "../src/routes/admin-prompts.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

describe("admin prompts", () => {
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

function makeEnv(): Env {
  return {
    ADMIN_TOKEN: "admin-token",
  } as unknown as Env;
}
