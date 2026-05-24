import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import { adminStatsRouter } from "../src/routes/admin-stats.ts";

interface ModerationTestRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  content_text: string | null;
  evidence_key: string | null;
  prefiltered_by: string | null;
  status: string;
  risk_level: string | null;
  categories: string;
  reason: string | null;
  provider: string | null;
  model: string | null;
  cached: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  created_at: number;
}

class FakeD1 {
  readonly rows: ModerationTestRow[] = [
    row("019f0000-0002", "pending"),
    row("019f0000-0001", "pass"),
  ];
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
  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM moderation_requests")) return { results: [] };
    let rows = [...this.db.rows];
    if (this.sql.includes("status = ?")) {
      rows = rows.filter((r) => r.status === this.args[0]);
    }
    rows.sort((a, b) => b.id.localeCompare(a.id));
    return { results: rows as T[] };
  }
}

describe("admin stats requests", () => {
  it("allows filtering moderation requests by pending status", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://local/admin/stats/requests?status=pending", {
      headers: adminHeaders(),
    }), makeEnv(new FakeD1()));

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; status: string }> };
    expect(body.items).toEqual([
      expect.objectContaining({ id: "019f0000-0002", status: "pending" }),
    ]);
  });
});

function row(id: string, status: string): ModerationTestRow {
  return {
    id,
    app_id: "app_1",
    biz_type: "comment",
    biz_id: id,
    user_id: null,
    content_text: "hello",
    evidence_key: null,
    prefiltered_by: null,
    status,
    risk_level: status === "pending" ? null : "safe",
    categories: "[]",
    reason: status,
    provider: null,
    model: null,
    cached: 0,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    created_at: Date.now(),
  };
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/stats", adminStatsRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db,
    ADMIN_TOKEN: "admin-token",
  } as unknown as Env;
}

function adminHeaders(): Headers {
  return new Headers({ authorization: "Bearer admin-token" });
}
