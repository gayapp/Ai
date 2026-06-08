import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getBackpressureCanary } from "../src/analyze/backpressure.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import { adminAnalyzeBackpressureCanaryRouter } from "../src/routes/admin-analyze-backpressure-canary.ts";

class MemKV {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeD1 {
  readonly app = {
    id: "app_irc",
    name: "IRC",
    secret: "secret",
    callback_url: null,
    biz_types: "[]",
    analyze_biz_types: JSON.stringify(["media_analysis", "media_intro"]),
    delivery_mode: "both",
    callback_max_concurrency: 10,
    rate_limit_qps: 50,
    disabled: 0,
    provider_strategy: "auto",
    created_at: Date.now(),
  };

  readonly auditActions: string[] = [];

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
    return null;
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO admin_audit_logs")) {
      this.db.auditActions.push(String(this.args[1]));
    }
    return { success: true } as D1Result;
  }
}

describe("admin analyze backpressure canary", () => {
  it("arms, reports, and clears an exact one-shot gate", async () => {
    const db = new FakeD1();
    const nonce = new MemKV();
    const env = makeEnv(db, nonce);
    const app = makeApp();

    const arm = await app.fetch(new Request("http://local/admin/analyze-backpressure-canary", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        app_id: "app_irc",
        biz_type: "media_analysis",
        biz_id: "video-canary-1",
        ttl_seconds: 60,
        reason: "IRC controlled acceptance",
      }),
    }), env);

    expect(arm.status).toBe(200);
    const armed = await arm.json() as {
      armed: boolean;
      gate: { app_id: string; biz_type: string; biz_id: string };
    };
    expect(armed.armed).toBe(true);
    expect(armed.gate).toEqual(expect.objectContaining({
      app_id: "app_irc",
      biz_type: "media_analysis",
      biz_id: "video-canary-1",
    }));
    expect(await getBackpressureCanary(env, "app_irc")).toEqual(
      expect.objectContaining({ biz_id: "video-canary-1" }),
    );

    const status = await app.fetch(new Request(
      "http://local/admin/analyze-backpressure-canary?app_id=app_irc",
      { headers: adminHeaders() },
    ), env);
    expect(status.status).toBe(200);
    expect((await status.json() as { armed: boolean }).armed).toBe(true);

    const clear = await app.fetch(new Request(
      "http://local/admin/analyze-backpressure-canary/app_irc",
      { method: "DELETE", headers: adminHeaders() },
    ), env);
    expect(clear.status).toBe(200);
    expect(await getBackpressureCanary(env, "app_irc")).toBeNull();
    expect(db.auditActions).toContain("analyze.backpressure_canary.arm");
    expect(db.auditActions).toContain("analyze.backpressure_canary.clear");
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/analyze-backpressure-canary", adminAnalyzeBackpressureCanaryRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    if (err && typeof err === "object" && "issues" in err) {
      return c.json({ error_code: ErrorCodes.INVALID_REQUEST, message: "validation failed" }, 400);
    }
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(db: FakeD1, nonce: MemKV): Env {
  return {
    DB: db,
    NONCE: nonce,
    ADMIN_TOKEN: "admin-token",
  } as unknown as Env;
}

function adminHeaders(): Headers {
  return new Headers({
    authorization: "Bearer admin-token",
    "content-type": "application/json",
    "x-admin-actor": "ops-test",
  });
}
