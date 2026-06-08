import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { PENDING_COUNT_KV_KEY } from "../src/analyze/backpressure.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import { adminStatsRouter } from "../src/routes/admin-stats.ts";

class MemKV {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

class FakeD1 {
  constructor(private readonly pendingCount: number) {}

  prepare(_sql: string): FakeStmt {
    return new FakeStmt(this.pendingCount);
  }
}

class FakeStmt {
  constructor(private readonly pendingCount: number) {}

  async first<T>(): Promise<T> {
    return { n: this.pendingCount } as T;
  }
}

describe("admin stats analyze backpressure", () => {
  it("reports KV cache state and actual pending count", async () => {
    const kv = new MemKV();
    await kv.put(PENDING_COUNT_KV_KEY, "123");
    const app = makeApp();

    const res = await app.fetch(new Request("http://local/admin/stats/analyze-backpressure", {
      headers: adminHeaders(),
    }), makeEnv(kv, 42));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      hard_limit: number;
      warn_threshold: number;
      kv: { state: string; cached_count: number };
      actual: { pending_count: number; severity: string };
      effective: { pending_count: number; source: string };
    };
    expect(body.hard_limit).toBe(500);
    expect(body.warn_threshold).toBe(300);
    expect(body.kv).toEqual(expect.objectContaining({ state: "hit", cached_count: 123 }));
    expect(body.actual).toEqual(expect.objectContaining({ pending_count: 42, severity: "ok" }));
    expect(body.effective).toEqual(expect.objectContaining({ pending_count: 123, source: "kv" }));
  });

  it("uses actual count as effective value when KV is missing", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://local/admin/stats/analyze-backpressure", {
      headers: adminHeaders(),
    }), makeEnv(new MemKV(), 501));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      kv: { state: string; cached_count: number | null };
      actual: { pending_count: number; severity: string };
      effective: { pending_count: number; severity: string; source: string };
    };
    expect(body.kv).toEqual(expect.objectContaining({ state: "miss", cached_count: null }));
    expect(body.actual).toEqual(expect.objectContaining({ pending_count: 501, severity: "crit" }));
    expect(body.effective).toEqual(expect.objectContaining({
      pending_count: 501,
      severity: "crit",
      source: "actual_fallback",
    }));
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/stats", adminStatsRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(kv: MemKV, pendingCount: number): Env {
  return {
    NONCE: kv,
    DB: new FakeD1(pendingCount),
    ADMIN_TOKEN: "admin-token",
  } as unknown as Env;
}

function adminHeaders(): Headers {
  return new Headers({ authorization: "Bearer admin-token" });
}
