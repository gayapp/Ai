import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminPromptRegressionRouter } from "../src/routes/admin-prompt-regression.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import type { PromptRegressionSetRow } from "../src/db/prompt-regression.ts";

interface PromptRow {
  biz_type: string;
  provider: string;
  version: number;
  content: string;
  is_active: number;
}

class FakeD1 {
  readonly sets: PromptRegressionSetRow[] = [];
  readonly prompts: PromptRow[] = [];
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
    if (this.sql.includes("INSERT INTO prompt_regression_sets")) {
      this.db.sets.push({
        id: this.db.nextId++,
        name: this.args[0] as string,
        biz_type: this.args[1] as string,
        provider: this.args[2] as string,
        samples_json: this.args[3] as string,
        created_by: this.args[4] as string | null,
        created_at: this.args[5] as number,
        updated_at: this.args[6] as number,
      });
    }
    if (this.sql.includes("UPDATE prompt_regression_sets")) {
      const id = this.args[this.args.length - 1] as number;
      const row = this.db.sets.find((set) => set.id === id);
      if (!row) return;
      let i = 0;
      if (this.sql.includes("name = ?")) row.name = this.args[i++] as string;
      if (this.sql.includes("samples_json = ?")) row.samples_json = this.args[i++] as string;
      row.updated_at = this.args[i] as number;
    }
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM prompt_regression_sets") && this.sql.includes("WHERE id = ?")) {
      return (this.db.sets.find((set) => set.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM prompt_regression_sets") && this.sql.includes("WHERE biz_type = ?")) {
      const [bizType, provider, name, createdAt] = this.args;
      const row = [...this.db.sets]
        .reverse()
        .find((set) =>
          set.biz_type === bizType &&
          set.provider === provider &&
          set.name === name &&
          set.created_at === createdAt,
        );
      return (row ?? null) as T | null;
    }
    if (this.sql.includes("SELECT version, content FROM prompts")) {
      const [bizType, provider] = this.args;
      const row = this.db.prompts.find((prompt) =>
        prompt.biz_type === bizType &&
        prompt.provider === provider &&
        prompt.is_active === 1,
      );
      return row ? { version: row.version, content: row.content } as T : null;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM prompt_regression_sets")) return { results: [] };
    let rows = [...this.db.sets];
    if (this.sql.includes("biz_type = ?") && this.sql.includes("provider = ?")) {
      rows = rows.filter((row) => row.biz_type === this.args[0] && row.provider === this.args[1]);
    }
    rows.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    return { results: rows as T[] };
  }
}

describe("admin prompt regression", () => {
  it("creates a media_analysis set and compares draft against active prompt", async () => {
    const db = new FakeD1();
    db.prompts.push({
      biz_type: "media_analysis",
      provider: "xai",
      version: 3,
      content: "Active media-analysis prompt",
      is_active: 1,
    });

    const app = makeApp();
    const create = await app.fetch(new Request("http://local/admin/prompt-regression", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "media analysis smoke",
        biz_type: "media_analysis",
        provider: "xai",
        samples: [{
          name: "single image",
          input: JSON.stringify({
            image_urls: ["https://example.com/frame.jpg"],
            title: "Clip",
            frame_metadata: [{ timestamp_seconds: 0, quality_score: 0.9 }],
          }),
        }],
      }),
    }), makeEnv(db));
    expect(create.status).toBe(201);
    const created = await create.json() as { id: number; sample_count: number };
    expect(created.sample_count).toBe(1);

    const run = await app.fetch(new Request(`http://local/admin/prompt-regression/${created.id}/run`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ draft_content: "Draft media-analysis prompt" }),
    }), makeEnv(db));
    expect(run.status).toBe(200);
    const body = await run.json() as {
      active_version: number;
      summary: { changed: number; draft_schema_failures: number };
      results: Array<{ changed: boolean; active: { prompt_preview: string }; draft: { prompt_preview: string } }>;
    };
    expect(body.active_version).toBe(3);
    expect(body.summary.changed).toBe(1);
    expect(body.summary.draft_schema_failures).toBe(0);
    expect(body.results[0].changed).toBe(true);
    expect(body.results[0].active.prompt_preview).toContain("Active media-analysis prompt");
    expect(body.results[0].draft.prompt_preview).toContain("Draft media-analysis prompt");
  });
});

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/prompt-regression", adminPromptRegressionRouter);
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
  return new Headers({
    authorization: "Bearer admin-token",
    "content-type": "application/json",
  });
}
