/** 统计汇总：从 moderation_requests 聚合日/时粒度到 stats_rollup。
 *
 *  调用点：scheduled handler 每天 00:05 跑一次（prod）。
 *  Dashboard 历史查询应走 stats_rollup，短时间查询直接扫原始表。
 */

export interface RollupResult {
  period: "hour" | "day";
  from: string;
  to: string;
  rows_read: number;
  rows_written: number;
}

/** Aggregate [from, to) into stats_rollup with the given period. */
export async function rollup(
  db: D1Database,
  period: "hour" | "day",
  from_ms: number,
  to_ms: number,
): Promise<RollupResult> {
  // Produce one row per (app_id, biz_type, provider) in the window.
  // For the hour rollup: period_start = hour floor of from_ms
  // For the day rollup: period_start = day floor of from_ms
  const bucket =
    period === "hour"
      ? Math.floor(from_ms / 3_600_000) * 3_600_000
      : Math.floor(from_ms / 86_400_000) * 86_400_000;

  const { results } = await db
    .prepare(
      `SELECT
         app_id,
         biz_type,
         COALESCE(provider, 'unknown') AS provider,
         COUNT(*) AS count_total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS count_cached,
         SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS count_pass,
         SUM(CASE WHEN status = 'reject' THEN 1 ELSE 0 END) AS count_reject,
         SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS count_review,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS count_error,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         CAST(COALESCE(AVG(latency_ms), 0) AS INTEGER) AS latency_p50_ms,
         CAST(COALESCE(MAX(latency_ms), 0) AS INTEGER) AS latency_p95_ms
       FROM moderation_requests
       WHERE created_at >= ? AND created_at < ?
       GROUP BY app_id, biz_type, provider`,
    )
    .bind(from_ms, to_ms)
    .all<{
      app_id: string;
      biz_type: string;
      provider: string;
      count_total: number;
      count_cached: number;
      count_pass: number;
      count_reject: number;
      count_review: number;
      count_error: number;
      input_tokens: number;
      output_tokens: number;
      latency_p50_ms: number;
      latency_p95_ms: number;
    }>();

  let written = 0;
  for (const r of results) {
    await db
      .prepare(
        `INSERT INTO stats_rollup
           (period, period_start, app_id, biz_type, provider,
            count_total, count_cached, count_pass, count_reject, count_review, count_error,
            input_tokens, output_tokens, latency_p50_ms, latency_p95_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(period, period_start, app_id, biz_type, provider) DO UPDATE SET
           count_total   = excluded.count_total,
           count_cached  = excluded.count_cached,
           count_pass    = excluded.count_pass,
           count_reject  = excluded.count_reject,
           count_review  = excluded.count_review,
           count_error   = excluded.count_error,
           input_tokens  = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           latency_p50_ms = excluded.latency_p50_ms,
           latency_p95_ms = excluded.latency_p95_ms`,
      )
      .bind(
        period, bucket, r.app_id, r.biz_type, r.provider,
        r.count_total, r.count_cached, r.count_pass, r.count_reject, r.count_review, r.count_error,
        r.input_tokens, r.output_tokens, r.latency_p50_ms, r.latency_p95_ms,
      )
      .run();
    written++;
  }

  return {
    period,
    from: new Date(from_ms).toISOString(),
    to: new Date(to_ms).toISOString(),
    rows_read: results.length,
    rows_written: written,
  };
}

/** Roll up yesterday — called from scheduled daily cron. */
export async function rollupYesterday(db: D1Database): Promise<RollupResult> {
  const now = Date.now();
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const from = dayStart - 86_400_000;
  const to = dayStart;
  return rollup(db, "day", from, to);
}
