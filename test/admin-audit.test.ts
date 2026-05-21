import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { logAdminAudit, type AdminAuditLogRow } from "../src/db/admin-audit.ts";
import { adminAuditRouter } from "../src/routes/admin-audit.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

class FakeD1 {
  readonly rows: AdminAuditLogRow[] = [];
  nextId = 1;
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
  async run(): Promise<void> {
    if (this.sql.includes("INSERT INTO admin_audit_logs")) {
      this.db.rows.push({
        id: this.db.nextId++,
        actor: this.args[0] as string,
        action: this.args[1] as string,
        target_type: this.args[2] as string,
        target_id: this.args[3] as string,
        metadata_json: this.args[4] as string | null,
        created_at: this.args[5] as number,
      });
    }
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM admin_audit_logs")) return { results: [] };
    let rows = [...this.db.rows];
    if (this.sql.includes("action = ?")) {
      rows = rows.filter((row) => row.action === this.args[0]);
    }
    rows.sort((a, b) => b.id - a.id);
    return { results: rows as T[] };
  }
}

describe("admin audit", () => {
  it("writes and lists admin audit logs without secrets in metadata", async () => {
    const db = new FakeD1();
    await logAdminAudit(db as unknown as D1Database, {
      actor: "ops@example.com",
      action: "app.rotate_secret",
      target_type: "app",
      target_id: "app_1",
      metadata: { name: "IRC" },
    });

    const app = makeApp();
    const res = await app.fetch(new Request("http://local/admin/audit?action=app.rotate_secret", {
      headers: adminHeaders(),
    }), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{ actor: string; action: string; metadata: Record<string, unknown> }>;
      next_cursor: number | null;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        actor: "ops@example.com",
        action: "app.rotate_secret",
        metadata: { name: "IRC" },
      }),
    ]);
    expect(JSON.stringify(body.items[0].metadata)).not.toContain("secret");
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/audit", adminAuditRouter);
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
