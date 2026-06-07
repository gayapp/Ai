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

  // M17: 之前 p50=AVG / p95=MAX 都是错的；改用 PERCENT_RANK 窗口函数算真 p50/p95。
  //   只统计 latency_ms > 0 的行（排除 cached / 极早期 / sweep give-up 等没真打 LLM 的样本）。
  const PERCENTILES_SQL = (table: string): string =>
    `WITH ranked AS (
       SELECT app_id, biz_type, COALESCE(provider, 'unknown') AS provider, latency_ms,
              PERCENT_RANK() OVER (
                PARTITION BY app_id, biz_type, COALESCE(provider, 'unknown')
                ORDER BY latency_ms
              ) AS pr
       FROM ${table}
       WHERE created_at >= ? AND created_at < ? AND latency_ms > 0
     )
     SELECT app_id, biz_type, provider,
            CAST(COALESCE(MIN(CASE WHEN pr >= 0.5  THEN latency_ms END), 0) AS INTEGER) AS p50,
            CAST(COALESCE(MIN(CASE WHEN pr >= 0.95 THEN latency_ms END), 0) AS INTEGER) AS p95
     FROM ranked
     GROUP BY app_id, biz_type, provider`;

  const { results: modPercentiles } = await db
    .prepare(PERCENTILES_SQL("moderation_requests"))
    .bind(from_ms, to_ms)
    .all<{ app_id: string; biz_type: string; provider: string; p50: number; p95: number }>();

  const { results: anPercentiles } = await db
    .prepare(PERCENTILES_SQL("analyze_requests"))
    .bind(from_ms, to_ms)
    .all<{ app_id: string; biz_type: string; provider: string; p50: number; p95: number }>();

  const modPctMap = new Map<string, { p50: number; p95: number }>();
  for (const p of modPercentiles) modPctMap.set(`${p.app_id}\x00${p.biz_type}\x00${p.provider}`, { p50: p.p50, p95: p.p95 });
  const anPctMap = new Map<string, { p50: number; p95: number }>();
  for (const p of anPercentiles) anPctMap.set(`${p.app_id}\x00${p.biz_type}\x00${p.provider}`, { p50: p.p50, p95: p.p95 });

  const { results: moderationCounts } = await db
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
         0 AS output_bytes_total
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
      output_bytes_total: number;
    }>();

  const moderation = moderationCounts.map((r) => {
    const pct = modPctMap.get(`${r.app_id}\x00${r.biz_type}\x00${r.provider}`) ?? { p50: 0, p95: 0 };
    return { ...r, latency_p50_ms: pct.p50, latency_p95_ms: pct.p95 };
  });

  const { results: analyzeCounts } = await db
    .prepare(
      `SELECT
         app_id,
         biz_type,
         COALESCE(provider, 'unknown') AS provider,
         COUNT(*) AS count_total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS count_cached,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS count_pass,
         0 AS count_reject,
         0 AS count_review,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS count_error,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(LENGTH(COALESCE(result_json, ''))), 0) AS output_bytes_total
       FROM analyze_requests
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
      output_bytes_total: number;
    }>();

  const analyze = analyzeCounts.map((r) => {
    const pct = anPctMap.get(`${r.app_id}\x00${r.biz_type}\x00${r.provider}`) ?? { p50: 0, p95: 0 };
    return { ...r, latency_p50_ms: pct.p50, latency_p95_ms: pct.p95 };
  });

  let written = 0;
  const results = [...moderation, ...analyze];
  for (const r of results) {
    await db
      .prepare(
        `INSERT INTO stats_rollup
           (period, period_start, app_id, biz_type, provider,
            count_total, count_cached, count_pass, count_reject, count_review, count_error,
            input_tokens, output_tokens, latency_p50_ms, latency_p95_ms, output_bytes_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           latency_p95_ms = excluded.latency_p95_ms,
           output_bytes_total = excluded.output_bytes_total`,
      )
      .bind(
        period, bucket, r.app_id, r.biz_type, r.provider,
        r.count_total, r.count_cached, r.count_pass, r.count_reject, r.count_review, r.count_error,
        r.input_tokens, r.output_tokens, r.latency_p50_ms, r.latency_p95_ms, r.output_bytes_total,
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
