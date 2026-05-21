import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminProvidersRouter } from "../src/routes/admin-providers.ts";
import { recordAuthFailure } from "../src/providers/circuit.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

class MemKV {
  private readonly m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
}

describe("admin providers", () => {
  it("reports configured models and circuit breaker state without upstream health checks", async () => {
    const nonce = new MemKV();
    await recordAuthFailure(nonce as unknown as KVNamespace, "gemini", "media_analysis");
    const app = makeApp();
    const res = await app.fetch(new Request("http://local/admin/providers/status", {
      headers: adminHeaders(),
    }), makeEnv(nonce));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      secrets: { grok_configured: boolean; gemini_configured: boolean };
      models: { grok: string; gemini: string };
      circuits: Array<{ provider: string; biz_type: string | null; state: string }>;
    };
    expect(body.secrets).toEqual({ grok_configured: true, gemini_configured: true });
    expect(body.models.grok).toBe("grok-test");
    expect(body.circuits).toContainEqual(expect.objectContaining({
      provider: "gemini",
      biz_type: "media_analysis",
      state: "open",
    }));
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/providers", adminProvidersRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(nonce: MemKV): Env {
  return {
    NONCE: nonce,
    ADMIN_TOKEN: "admin-token",
    GROK_API_KEY: "xai-key",
    GEMINI_API_KEY: "gemini-key",
    GROK_MODEL: "grok-test",
    GEMINI_MODEL: "gemini-test",
  } as unknown as Env;
}

function adminHeaders(): Headers {
  return new Headers({ authorization: "Bearer admin-token" });
}
