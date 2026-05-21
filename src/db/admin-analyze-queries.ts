import type { AnalyzeBizType, AnalyzeRow, AnalyzeStatus, DeliveryMode } from "../analyze/types.ts";

export interface ListAdminAnalyzeArgs {
  app_id?: string;
  biz_type?: AnalyzeBizType;
  biz_id?: string;
  status?: AnalyzeStatus;
  delivery_mode?: DeliveryMode;
  from_ms?: number;
  to_ms?: number;
  limit?: number;
  cursor?: string;
}

export interface AnalyzeSummaryRow {
  count_total: number;
  count_cached: number;
  count_pending: number;
  count_ok: number;
  count_error: number;
  input_tokens: number;
  output_tokens: number;
  output_bytes_total: number;
}

export type AnalyzeGrayMetricRow = Pick<
  AnalyzeRow,
  | "id"
  | "app_id"
  | "biz_type"
  | "status"
  | "cached"
  | "input_tokens"
  | "output_tokens"
  | "latency_ms"
  | "error_code"
  | "delivery_mode"
  | "delivered_at"
  | "acked_at"
  | "created_at"
  | "completed_at"
>;

export async function listAdminAnalyzeRequests(
  db: D1Database,
  opts: ListAdminAnalyzeArgs,
): Promise<{ items: AnalyzeRow[]; nextCursor: string | null }> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }
  if (opts.biz_type) {
    where.push("biz_type = ?");
    vals.push(opts.biz_type);
  }
  if (opts.biz_id) {
    where.push("biz_id = ?");
    vals.push(opts.biz_id);
  }
  if (opts.status) {
    where.push("status = ?");
    vals.push(opts.status);
  }
  if (opts.delivery_mode) {
    where.push("delivery_mode = ?");
    vals.push(opts.delivery_mode);
  }
  if (opts.from_ms !== undefined) {
    where.push("created_at >= ?");
    vals.push(opts.from_ms);
  }
  if (opts.to_ms !== undefined) {
    where.push("created_at <= ?");
    vals.push(opts.to_ms);
  }
  if (opts.cursor) {
    where.push("id < ?");
    vals.push(opts.cursor);
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const sql =
    `SELECT * FROM analyze_requests` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY id DESC LIMIT ?`;
  vals.push(limit + 1);
  const { results } = await db.prepare(sql).bind(...vals).all<AnalyzeRow>();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  return {
    items,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}

export async function getAdminAnalyzeRequest(
  db: D1Database,
  id: string,
): Promise<AnalyzeRow | null> {
  return await db
    .prepare(`SELECT * FROM analyze_requests WHERE id = ?`)
    .bind(id)
    .first<AnalyzeRow>();
}

export async function summarizeAnalyzeRequests(
  db: D1Database,
  opts: { app_id?: string; from_ms: number; to_ms: number },
): Promise<AnalyzeSummaryRow> {
  const where: string[] = ["created_at >= ?", "created_at <= ?"];
  const vals: unknown[] = [opts.from_ms, opts.to_ms];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS count_total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS count_cached,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS count_pending,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS count_ok,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS count_error,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(LENGTH(COALESCE(result_json, ''))), 0) AS output_bytes_total
       FROM analyze_requests
       WHERE ${where.join(" AND ")}`,
    )
    .bind(...vals)
    .first<AnalyzeSummaryRow>();
  return row ?? {
    count_total: 0,
    count_cached: 0,
    count_pending: 0,
    count_ok: 0,
    count_error: 0,
    input_tokens: 0,
    output_tokens: 0,
    output_bytes_total: 0,
  };
}

export async function loadAnalyzeGrayMetricRows(
  db: D1Database,
  opts: { app_id?: string; from_ms: number; to_ms: number; limit?: number },
): Promise<AnalyzeGrayMetricRow[]> {
  const where: string[] = ["created_at >= ?", "created_at <= ?"];
  const vals: unknown[] = [opts.from_ms, opts.to_ms];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }

  const limit = Math.min(Math.max(opts.limit ?? 10000, 1), 50000);
  vals.push(limit);
  const { results } = await db
    .prepare(
      `SELECT
         id, app_id, biz_type, status, cached, input_tokens, output_tokens,
         latency_ms, error_code, delivery_mode, delivered_at, acked_at,
         created_at, completed_at
       FROM analyze_requests
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...vals)
    .all<AnalyzeGrayMetricRow>();
  return results;
}
