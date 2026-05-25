import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminAnalyzeRecordsRouter } from "../src/routes/admin-analyze-records.ts";
import { adminStatsRouter } from "../src/routes/admin-stats.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import type { AnalyzeRow } from "../src/analyze/types.ts";

class FakeD1 {
  readonly rows: AnalyzeRow[];

  constructor(rows?: AnalyzeRow[]) {
    this.rows = rows ?? [
      makeRow("r002", "media_intro", "video-2", "error", null),
      makeRow("r001", "media_analysis", "video-1", "ok", { summary: "done" }),
    ];
  }
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class MemQueue<T> {
  readonly messages: T[] = [];

  async send(message: T): Promise<void> {
    this.messages.push(message);
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
    if (this.sql.includes("FROM analyze_requests")) {
      let rows = this.filteredRows();
      rows.sort((a, b) => b.id.localeCompare(a.id));
      return { results: rows as T[] };
    }
    return { results: [] };
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("WHERE id = ?")) {
      return (this.db.rows.find((r) => r.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("COUNT(*) AS total FROM analyze_requests")) {
      return { total: this.filteredRows().length } as T;
    }
    if (this.sql.includes("COUNT(*) AS count_total")) {
      return {
        count_total: this.db.rows.length,
        count_cached: 0,
        count_pending: 0,
        count_ok: this.db.rows.filter((r) => r.status === "ok").length,
        count_error: this.db.rows.filter((r) => r.status === "error").length,
        input_tokens: 3,
        output_tokens: 4,
        output_bytes_total: this.db.rows.reduce((n, r) => n + (r.result_json?.length ?? 0), 0),
      } as T;
    }
    if (this.sql.includes("pending_total")) {
      return makeBacklogRow(this.db.rows) as T;
    }
    return null;
  }
  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO analyze_requests")) {
      this.db.rows.push({
        id: String(this.args[0]),
        app_id: String(this.args[1]),
        biz_type: String(this.args[2]),
        biz_id: String(this.args[3]),
        user_id: this.args[4] === null ? null : String(this.args[4]),
        input_hash: String(this.args[5]),
        input_json: String(this.args[6]),
        prompt_version: null,
        provider: null,
        model: null,
        mode: String(this.args[7]),
        cached: 0,
        status: "pending",
        result_json: null,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: null,
        delivery_mode: String(this.args[8]),
        callback_url: this.args[9] === null ? null : String(this.args[9]),
        extra_json: this.args[10] === null ? null : String(this.args[10]),
        delivered_at: null,
        acked_at: null,
        created_at: Number(this.args[11]),
        completed_at: null,
      });
    }
    return { success: true } as D1Result;
  }

  private filteredRows(): AnalyzeRow[] {
    let arg = 0;
    let rows = [...this.db.rows];
    if (this.sql.includes("r.status = 'error'")) {
      rows = rows.filter((r) => r.status === "error");
    }
    if (this.sql.includes("app_id = ?")) {
      const value = this.args[arg++];
      rows = rows.filter((r) => r.app_id === value);
    }
    if (this.sql.includes("biz_type = ?")) {
      const value = this.args[arg++];
      rows = rows.filter((r) => r.biz_type === value);
    }
    if (this.sql.includes("biz_id = ?")) {
      const value = this.args[arg++];
      rows = rows.filter((r) => r.biz_id === value);
    }
    if (this.sql.includes("status = ?")) {
      const value = this.args[arg++];
      rows = rows.filter((r) => r.status === value);
    }
    if (this.sql.includes("delivery_mode = ?")) {
      const value = this.args[arg++];
      rows = rows.filter((r) => r.delivery_mode === value);
    }
    if (this.sql.includes("created_at >= ?")) {
      const value = Number(this.args[arg++]);
      rows = rows.filter((r) => r.created_at >= value);
    }
    if (this.sql.includes("created_at <= ?")) {
      const value = Number(this.args[arg++]);
      rows = rows.filter((r) => r.created_at <= value);
    }
    if (this.sql.includes("id < ?")) {
      const value = String(this.args[arg++]);
      rows = rows.filter((r) => r.id < value);
    }
    if (this.sql.includes("newer_error")) {
      rows = rows.filter((r) => !this.db.rows.some((candidate) =>
        candidate.app_id === r.app_id &&
        candidate.biz_type === r.biz_type &&
        candidate.biz_id === r.biz_id &&
        candidate.status === "error" &&
        candidate.created_at > r.created_at
      ));
    }
    if (this.sql.includes("newer_ok")) {
      rows = rows.filter((r) => !this.db.rows.some((candidate) =>
        candidate.app_id === r.app_id &&
        candidate.biz_type === r.biz_type &&
        candidate.biz_id === r.biz_id &&
        candidate.status === "ok" &&
        candidate.created_at > r.created_at
      ));
    }
    return rows;
  }
}

describe("admin analyze records", () => {
  it("lists and details long-retained analyze input/result records", async () => {
    const app = makeApp();
    const env = makeEnv();
    const list = await app.fetch(new Request("http://local/admin/analyze-records?biz_id=video-1", {
      headers: adminHeaders(),
    }), env);
    expect(list.status).toBe(200);
    const listBody = await list.json() as { items: Array<{ request_id: string; biz_id: string }>; total: number };
    expect(listBody.items).toEqual([
      expect.objectContaining({ request_id: "r001", biz_id: "video-1" }),
    ]);
    expect(listBody.total).toBe(1);

    const detail = await app.fetch(new Request("http://local/admin/analyze-records/r001", {
      headers: adminHeaders(),
    }), env);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { input: unknown; result: unknown };
    expect(detailBody).toMatchObject({
      input: { title: "Title r001" },
      result: { summary: "done" },
    });
  });

  it("summarizes analyze records for the dashboard analyze tab", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await app.fetch(new Request("http://local/admin/stats/analyze-summary", {
      headers: adminHeaders(),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      by_status: { ok: number; error: number };
      output_bytes_total: number;
    };
    expect(body.total).toBe(2);
    expect(body.by_status).toEqual({ pending: 0, ok: 1, error: 1 });
    expect(body.output_bytes_total).toBeGreaterThan(0);
  });

  it("reports analyze gray readiness gates and distributions", async () => {
    const now = Date.now();
    const rows = [
      makeRow("r004", "media_analysis", "video-4", "ok", { summary: "done" }, {
        cached: 1,
        latency_ms: 200,
        output_tokens: 90,
        delivered_at: now,
        acked_at: now,
        created_at: now - 4000,
      }),
      makeRow("r003", "media_intro", "video-3", "ok", { intro: "ready" }, {
        cached: 1,
        latency_ms: 160,
        output_tokens: 80,
        delivered_at: now,
        acked_at: now,
        created_at: now - 3000,
      }),
      makeRow("r002", "media_analysis", "video-2", "ok", { summary: "done" }, {
        latency_ms: 120,
        output_tokens: 60,
        delivered_at: now,
        acked_at: now,
        created_at: now - 2000,
      }),
      makeRow("r001", "media_analysis", "video-1", "ok", { summary: "done" }, {
        latency_ms: 100,
        output_tokens: 40,
        delivered_at: now,
        acked_at: now,
        created_at: now - 1000,
      }),
    ];
    const app = makeApp();
    const env = makeEnv(rows);
    const res = await app.fetch(new Request("http://local/admin/stats/analyze-gray?baseline_p95_ms=140&limit=10", {
      headers: adminHeaders(),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sample_size: number;
      ready_for_next_stage: boolean;
      gates: Record<string, boolean>;
      status: { by_status: { pending: number; ok: number; error: number } };
      latency_ms: { p95: number };
      tokens: { output: { p95: number } };
      dedup: { hit_rate: number };
      by_biz_type: Record<string, number>;
    };
    expect(body.sample_size).toBe(4);
    expect(body.ready_for_next_stage).toBe(true);
    expect(body.gates.error_rate_under_1_percent).toBe(true);
    expect(body.status.by_status).toEqual({ pending: 0, ok: 4, error: 0 });
    expect(body.latency_ms.p95).toBe(200);
    expect(body.tokens.output.p95).toBe(90);
    expect(body.dedup.hit_rate).toBe(0.5);
    expect(body.by_biz_type).toEqual({ media_analysis: 3, media_intro: 1 });
  });

  it("reports analyze backlog age buckets for ops console", async () => {
    const now = Date.now();
    const rows = [
      makeRow("r004", "media_analysis", "video-4", "pending", null, {
        created_at: now - 3 * 60 * 1000,
        completed_at: null,
      }),
      makeRow("r003", "media_intro", "video-3", "pending", null, {
        created_at: now - 40 * 60 * 1000,
        completed_at: null,
      }),
      makeRow("r002", "media_analysis", "video-2", "ok", { summary: "done" }, {
        delivered_at: now,
        acked_at: null,
        created_at: now - 10 * 60 * 1000,
      }),
      makeRow("r001", "media_analysis", "video-1", "ok", { summary: "done" }, {
        delivered_at: null,
        acked_at: now,
        created_at: now - 3 * 60 * 60 * 1000,
      }),
    ];
    const app = makeApp();
    const env = makeEnv(rows);
    const res = await app.fetch(new Request("http://local/admin/stats/analyze-backlog", {
      headers: adminHeaders(),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pending: { total: number; older_than_30m: number; age_buckets: Record<string, number> };
      pull_unacked: { total: number; older_than_5m: number };
      callback_undelivered: { total: number; older_than_2h: number };
    };
    expect(body.pending.total).toBe(2);
    expect(body.pending.older_than_30m).toBe(1);
    expect(body.pending.age_buckets.lt_5m).toBe(1);
    expect(body.pull_unacked).toMatchObject({ total: 1, older_than_5m: 1 });
    expect(body.callback_undelivered).toMatchObject({ total: 1, older_than_2h: 1 });
  });

  it("reprocesses latest failed analyze records without replacing audit rows", async () => {
    const now = Date.now();
    const rows = [
      makeRow("r004", "media_analysis", "video-ok-later", "ok", { summary: "done" }, {
        created_at: now,
        error_code: null,
      }),
      makeRow("r003", "media_analysis", "video-ok-later", "error", null, {
        created_at: now - 1000,
        error_code: "schema_validation_failed",
      }),
      makeRow("r002", "media_analysis", "video-failed", "error", null, {
        created_at: now - 500,
        error_code: "schema_validation_failed",
      }),
      makeRow("r001", "media_analysis", "video-failed", "error", null, {
        created_at: now - 2000,
        error_code: "schema_validation_failed",
      }),
    ];
    const app = makeApp();
    const queue = new MemQueue<object>();
    const env = makeEnv(rows, queue);
    const headers = adminHeaders();
    headers.set("content-type", "application/json");
    const res = await app.fetch(new Request("http://local/admin/analyze-records/reprocess", {
      method: "POST",
      headers,
      body: JSON.stringify({
        app_id: "app_a",
        error_code: "schema_validation_failed",
        limit: 10,
      }),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      selected: number;
      enqueued: number;
      items: Array<{ original_request_id: string; request_id: string; biz_id: string }>;
    };
    expect(body.selected).toBe(1);
    expect(body.enqueued).toBe(1);
    expect(body.items[0]).toMatchObject({
      original_request_id: "r002",
      biz_id: "video-failed",
    });
    expect(queue.messages).toHaveLength(1);

    const created = rows.find((r) => r.id === body.items[0].request_id);
    expect(created).toMatchObject({
      app_id: "app_a",
      biz_type: "media_analysis",
      biz_id: "video-failed",
      mode: "async",
      status: "pending",
      delivery_mode: "both",
      callback_url: "https://consumer.example.com/analyze",
    });
    expect(JSON.parse(created?.extra_json ?? "{}")).toMatchObject({
      trace_id: "r002",
      reprocess: {
        original_request_id: "r002",
        original_error_code: "schema_validation_failed",
      },
    });
  });
});

function makeBacklogRow(rows: AnalyzeRow[]) {
  const now = Date.now();
  const cutoff5m = now - 5 * 60 * 1000;
  const cutoff30m = now - 30 * 60 * 1000;
  const cutoff2h = now - 2 * 60 * 60 * 1000;
  const pending = rows.filter((r) => r.status === "pending");
  const pull = rows.filter(
    (r) => (r.status === "ok" || r.status === "error") &&
      (r.delivery_mode === "pull" || r.delivery_mode === "both") &&
      !r.acked_at,
  );
  const callback = rows.filter(
    (r) => (r.status === "ok" || r.status === "error") &&
      (r.delivery_mode === "callback" || r.delivery_mode === "both") &&
      !r.delivered_at,
  );
  const buckets = (subset: AnalyzeRow[]) => ({
    lt_5m: subset.filter((r) => r.created_at >= cutoff5m).length,
    m5_30m: subset.filter((r) => r.created_at < cutoff5m && r.created_at >= cutoff30m).length,
    m30_2h: subset.filter((r) => r.created_at < cutoff30m && r.created_at >= cutoff2h).length,
    gt_2h: subset.filter((r) => r.created_at < cutoff2h).length,
  });
  const oldest = (subset: AnalyzeRow[]) =>
    subset.length ? Math.min(...subset.map((r) => r.created_at)) : null;
  const pendingBuckets = buckets(pending);
  const pullBuckets = buckets(pull);
  const callbackBuckets = buckets(callback);
  return {
    pending_total: pending.length,
    pending_older_than_5m: pending.filter((r) => r.created_at < cutoff5m).length,
    pending_older_than_30m: pending.filter((r) => r.created_at < cutoff30m).length,
    pending_older_than_2h: pending.filter((r) => r.created_at < cutoff2h).length,
    pending_lt_5m: pendingBuckets.lt_5m,
    pending_5m_30m: pendingBuckets.m5_30m,
    pending_30m_2h: pendingBuckets.m30_2h,
    pending_gt_2h: pendingBuckets.gt_2h,
    pull_unacked_total: pull.length,
    pull_unacked_older_than_5m: pull.filter((r) => r.created_at < cutoff5m).length,
    pull_unacked_older_than_30m: pull.filter((r) => r.created_at < cutoff30m).length,
    pull_unacked_older_than_2h: pull.filter((r) => r.created_at < cutoff2h).length,
    pull_unacked_lt_5m: pullBuckets.lt_5m,
    pull_unacked_5m_30m: pullBuckets.m5_30m,
    pull_unacked_30m_2h: pullBuckets.m30_2h,
    pull_unacked_gt_2h: pullBuckets.gt_2h,
    callback_undelivered_total: callback.length,
    callback_undelivered_older_than_5m: callback.filter((r) => r.created_at < cutoff5m).length,
    callback_undelivered_older_than_30m: callback.filter((r) => r.created_at < cutoff30m).length,
    callback_undelivered_older_than_2h: callback.filter((r) => r.created_at < cutoff2h).length,
    callback_undelivered_lt_5m: callbackBuckets.lt_5m,
    callback_undelivered_5m_30m: callbackBuckets.m5_30m,
    callback_undelivered_30m_2h: callbackBuckets.m30_2h,
    callback_undelivered_gt_2h: callbackBuckets.gt_2h,
    oldest_pending_at: oldest(pending),
    oldest_pull_unacked_at: oldest(pull),
    oldest_callback_undelivered_at: oldest(callback),
  };
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/admin/analyze-records", adminAnalyzeRecordsRouter);
  app.route("/admin/stats", adminStatsRouter);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
  });
  return app;
}

function makeEnv(rows?: AnalyzeRow[], queue = new MemQueue<object>()): Env {
  return {
    DB: new FakeD1(rows),
    ANALYZE_QUEUE: queue,
    ADMIN_TOKEN: "admin-token",
  } as unknown as Env;
}

function adminHeaders(): Headers {
  return new Headers({ authorization: "Bearer admin-token" });
}

function makeRow(
  id: string,
  bizType: string,
  bizId: string,
  status: string,
  result: Record<string, unknown> | null,
  overrides: Partial<AnalyzeRow> = {},
): AnalyzeRow {
  return {
    id,
    app_id: "app_a",
    biz_type: bizType,
    biz_id: bizId,
    user_id: null,
    input_hash: `hash-${id}`,
    input_json: JSON.stringify({ title: `Title ${id}` }),
    prompt_version: 1,
    provider: "xai",
    model: "grok-test",
    mode: "async",
    cached: 0,
    status,
    result_json: result ? JSON.stringify(result) : null,
    input_tokens: 1,
    output_tokens: 2,
    latency_ms: 10,
    error_code: status === "error" ? "provider_error" : null,
    delivery_mode: "both",
    callback_url: "https://consumer.example.com/analyze",
    extra_json: JSON.stringify({ trace_id: id }),
    delivered_at: null,
    acked_at: null,
    created_at: Date.now(),
    completed_at: Date.now(),
    ...overrides,
  };
}
