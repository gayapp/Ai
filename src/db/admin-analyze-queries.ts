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

export interface ListAnalyzeReprocessCandidatesArgs {
  app_id?: string;
  biz_type?: AnalyzeBizType;
  error_code?: string;
  from_ms?: number;
  to_ms?: number;
  limit?: number;
  cursor?: string;
  latest_per_biz?: boolean;
  only_without_later_ok?: boolean;
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

export interface AnalyzeBacklogRow {
  pending_total: number;
  pending_older_than_5m: number;
  pending_older_than_30m: number;
  pending_older_than_2h: number;
  pending_lt_5m: number;
  pending_5m_30m: number;
  pending_30m_2h: number;
  pending_gt_2h: number;
  pull_unacked_total: number;
  pull_unacked_older_than_5m: number;
  pull_unacked_older_than_30m: number;
  pull_unacked_older_than_2h: number;
  pull_unacked_lt_5m: number;
  pull_unacked_5m_30m: number;
  pull_unacked_30m_2h: number;
  pull_unacked_gt_2h: number;
  callback_undelivered_total: number;
  callback_undelivered_older_than_5m: number;
  callback_undelivered_older_than_30m: number;
  callback_undelivered_older_than_2h: number;
  callback_undelivered_lt_5m: number;
  callback_undelivered_5m_30m: number;
  callback_undelivered_30m_2h: number;
  callback_undelivered_gt_2h: number;
  oldest_pending_at: number | null;
  oldest_pull_unacked_at: number | null;
  oldest_callback_undelivered_at: number | null;
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
): Promise<{ items: AnalyzeRow[]; nextCursor: string | null; total: number }> {
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
  const countSql =
    `SELECT COUNT(*) AS total FROM analyze_requests` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const countRow = await db.prepare(countSql).bind(...vals).first<{ total: number }>();

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
    total: countRow?.total ?? 0,
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

export async function listAnalyzeReprocessCandidates(
  db: D1Database,
  opts: ListAnalyzeReprocessCandidatesArgs,
): Promise<{ items: AnalyzeRow[]; nextCursor: string | null }> {
  const where: string[] = ["r.status = 'error'"];
  const vals: unknown[] = [];
  if (opts.app_id) {
    where.push("r.app_id = ?");
    vals.push(opts.app_id);
  }
  if (opts.biz_type) {
    where.push("r.biz_type = ?");
    vals.push(opts.biz_type);
  }
  if (opts.error_code) {
    where.push("r.error_code = ?");
    vals.push(opts.error_code);
  }
  if (opts.from_ms !== undefined) {
    where.push("r.created_at >= ?");
    vals.push(opts.from_ms);
  }
  if (opts.to_ms !== undefined) {
    where.push("r.created_at <= ?");
    vals.push(opts.to_ms);
  }
  if (opts.cursor) {
    where.push("r.id < ?");
    vals.push(opts.cursor);
  }
  if (opts.latest_per_biz !== false) {
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM analyze_requests newer_error
         WHERE newer_error.app_id = r.app_id
           AND newer_error.biz_type = r.biz_type
           AND newer_error.biz_id = r.biz_id
           AND newer_error.status = 'error'
           AND newer_error.created_at > r.created_at
       )`,
    );
  }
  if (opts.only_without_later_ok !== false) {
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM analyze_requests newer_ok
         WHERE newer_ok.app_id = r.app_id
           AND newer_ok.biz_type = r.biz_type
           AND newer_ok.biz_id = r.biz_id
           AND newer_ok.status = 'ok'
           AND newer_ok.created_at > r.created_at
       )`,
    );
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { results } = await db
    .prepare(
      `SELECT r.* FROM analyze_requests r
       WHERE ${where.join(" AND ")}
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .bind(...vals, limit + 1)
    .all<AnalyzeRow>();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  return {
    items,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
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
         COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) AS count_cached,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS count_pending,
         COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS count_ok,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS count_error,
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

export async function summarizeAnalyzeBacklog(
  db: D1Database,
  opts: { app_id?: string; from_ms: number; to_ms: number; now_ms: number },
): Promise<AnalyzeBacklogRow> {
  const where: string[] = ["created_at >= ?", "created_at <= ?"];
  const vals: unknown[] = [opts.from_ms, opts.to_ms];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }
  const cutoff5m = opts.now_ms - 5 * 60 * 1000;
  const cutoff30m = opts.now_ms - 30 * 60 * 1000;
  const cutoff2h = opts.now_ms - 2 * 60 * 60 * 1000;

  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_total,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? THEN 1 ELSE 0 END), 0) AS pending_older_than_5m,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? THEN 1 ELSE 0 END), 0) AS pending_older_than_30m,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? THEN 1 ELSE 0 END), 0) AS pending_older_than_2h,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pending_lt_5m,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pending_5m_30m,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pending_30m_2h,
         COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? THEN 1 ELSE 0 END), 0) AS pending_gt_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL THEN 1 ELSE 0 END), 0) AS pull_unacked_total,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS pull_unacked_older_than_5m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS pull_unacked_older_than_30m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS pull_unacked_older_than_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pull_unacked_lt_5m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pull_unacked_5m_30m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS pull_unacked_30m_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS pull_unacked_gt_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL THEN 1 ELSE 0 END), 0) AS callback_undelivered_total,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_older_than_5m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_older_than_30m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_older_than_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at >= ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_lt_5m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_5m_30m,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? AND created_at >= ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_30m_2h,
         COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_gt_2h,
         MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at,
         MIN(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('pull','both') AND acked_at IS NULL THEN created_at END) AS oldest_pull_unacked_at,
         MIN(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL THEN created_at END) AS oldest_callback_undelivered_at
       FROM analyze_requests
       WHERE ${where.join(" AND ")}`,
    )
    .bind(
      cutoff5m, cutoff30m, cutoff2h,
      cutoff5m, cutoff5m, cutoff30m, cutoff30m, cutoff2h, cutoff2h,
      cutoff5m, cutoff30m, cutoff2h,
      cutoff5m, cutoff5m, cutoff30m, cutoff30m, cutoff2h, cutoff2h,
      cutoff5m, cutoff30m, cutoff2h,
      cutoff5m, cutoff5m, cutoff30m, cutoff30m, cutoff2h, cutoff2h,
      ...vals,
    )
    .first<AnalyzeBacklogRow>();

  return row ?? emptyBacklog();
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

function emptyBacklog(): AnalyzeBacklogRow {
  return {
    pending_total: 0,
    pending_older_than_5m: 0,
    pending_older_than_30m: 0,
    pending_older_than_2h: 0,
    pending_lt_5m: 0,
    pending_5m_30m: 0,
    pending_30m_2h: 0,
    pending_gt_2h: 0,
    pull_unacked_total: 0,
    pull_unacked_older_than_5m: 0,
    pull_unacked_older_than_30m: 0,
    pull_unacked_older_than_2h: 0,
    pull_unacked_lt_5m: 0,
    pull_unacked_5m_30m: 0,
    pull_unacked_30m_2h: 0,
    pull_unacked_gt_2h: 0,
    callback_undelivered_total: 0,
    callback_undelivered_older_than_5m: 0,
    callback_undelivered_older_than_30m: 0,
    callback_undelivered_older_than_2h: 0,
    callback_undelivered_lt_5m: 0,
    callback_undelivered_5m_30m: 0,
    callback_undelivered_30m_2h: 0,
    callback_undelivered_gt_2h: 0,
    oldest_pending_at: null,
    oldest_pull_unacked_at: null,
    oldest_callback_undelivered_at: null,
  };
}
