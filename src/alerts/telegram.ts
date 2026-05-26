/** Telegram 告警模块 —— 基于 Bot API sendMessage。
 *  仅当 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 两个 secret 都配置了才生效。
 *  未配置时所有告警调用都是 no-op（返回 false），不报错。
 */

export interface AlertContext {
  title: string;
  level: "info" | "warn" | "crit";
  lines: string[];
  /** 去重 key，短时间重复命中同 key 不重发（默认 5min 窗口）。 */
  dedupKey?: string;
  dedupTtlSeconds?: number;
}

/**
 * Sends an alert to Telegram. Returns true on success, false if disabled or failed.
 */
export async function sendTelegramAlert(
  env: Env,
  ctx: AlertContext,
  kv: KVNamespace,
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  if (ctx.dedupKey) {
    const seen = await kv.get(`alert-dedup:${ctx.dedupKey}`);
    if (seen) return false;
    await kv.put(`alert-dedup:${ctx.dedupKey}`, "1", {
      expirationTtl: ctx.dedupTtlSeconds ?? 300,
    });
  }

  const emoji = { info: "ℹ️", warn: "⚠️", crit: "🚨" }[ctx.level];
  const text =
    `${emoji} *${escape(ctx.title)}*\n` +
    ctx.lines.map(escape).join("\n") +
    `\n\n_${new Date().toISOString()}_`;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) {
      console.warn("[telegram] http", res.status, await safeText(res));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[telegram] failed", e);
    return false;
  }
}

/** Markdown V1 escapes — we use "Markdown" mode, minimal escape set. */
function escape(s: string): string {
  return s.replace(/([_*`\[])/g, "\\$1");
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

// =============================================================
// Thresholds + health check (called from scheduled handler)
// =============================================================

export interface AlertThresholds {
  errorRatePct: number;   // 5 = 5%
  p95LatencyMs: number;   // 15000 = 15s (Gemini)
  sampleWindowMs: number; // 5 * 60 * 1000
  minSample: number;      // require at least N requests in window
  dlqNonEmpty: boolean;   // fire on any DLQ content
  analyzeErrorRatePct: number;
  analyzeLatencyMs: number;
  analyzeMinSample: number;
  analyzePendingOlderThanMs: number;
  analyzePullUnackedOlderThanMs: number;
  analyzePullUnackedMinCount: number;
  analyzeCallbackUndeliveredOlderThanMs: number;
  analyzeCallbackUndeliveredMinCount: number;
  analyzeBacklogWindowMs: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  errorRatePct: 5,
  p95LatencyMs: 15_000,
  sampleWindowMs: 5 * 60 * 1000,
  minSample: 20,
  dlqNonEmpty: true,
  analyzeErrorRatePct: 5,
  analyzeLatencyMs: 90_000,
  analyzeMinSample: 20,
  analyzePendingOlderThanMs: 5 * 60 * 1000,
  analyzePullUnackedOlderThanMs: 2 * 60 * 60 * 1000,
  analyzePullUnackedMinCount: 20,
  analyzeCallbackUndeliveredOlderThanMs: 30 * 60 * 1000,
  analyzeCallbackUndeliveredMinCount: 1,
  analyzeBacklogWindowMs: 24 * 60 * 60 * 1000,
};

export async function checkAndAlert(
  env: Env,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): Promise<{ checks: string[]; fired: string[] }> {
  const now = Date.now();
  const from = now - thresholds.sampleWindowMs;

  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
       COALESCE(AVG(latency_ms), 0) AS avg_lat,
       COALESCE(MAX(latency_ms), 0) AS max_lat
     FROM moderation_requests
     WHERE created_at >= ?`,
  )
    .bind(from)
    .first<{ total: number; errors: number; avg_lat: number; max_lat: number }>();

  const checks: string[] = [];
  const fired: string[] = [];

  if (!row || row.total < thresholds.minSample) {
    checks.push(`moderate samples=${row?.total ?? 0} < min=${thresholds.minSample} -> skip`);
  } else {
    const errRatePct = (row.errors / row.total) * 100;
    checks.push(
      `moderate total=${row.total} errors=${row.errors} err_rate=${errRatePct.toFixed(2)}% max_lat=${row.max_lat}ms`,
    );

    if (errRatePct >= thresholds.errorRatePct) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · 错误率告警",
          level: errRatePct >= 20 ? "crit" : "warn",
          lines: [
            `时间窗口: 最近 ${thresholds.sampleWindowMs / 60000} 分钟`,
            `请求总数: ${row.total}`,
            `错误数: ${row.errors}`,
            `错误率: ${errRatePct.toFixed(2)}%（阈值 ${thresholds.errorRatePct}%）`,
            ``,
            `排查: https://aicenter.1.gay/#/requests?status=error`,
          ],
          dedupKey: `error-rate-${Math.floor(errRatePct / 5)}`,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("error-rate");
    }

    if (row.max_lat >= thresholds.p95LatencyMs) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · 延迟告警",
          level: "warn",
          lines: [
            `时间窗口: 最近 ${thresholds.sampleWindowMs / 60000} 分钟`,
            `最高延迟: ${row.max_lat}ms（阈值 ${thresholds.p95LatencyMs}ms）`,
            `平均延迟: ${Math.round(row.avg_lat)}ms`,
            `样本数: ${row.total}`,
          ],
          dedupKey: `latency-high`,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("latency");
    }
  }

  const analyze = await checkAnalyzeAndAlert(env, now, thresholds);
  checks.push(...analyze.checks);
  fired.push(...analyze.fired);

  return { checks, fired };
}

async function checkAnalyzeAndAlert(
  env: Env,
  now: number,
  thresholds: AlertThresholds,
): Promise<{ checks: string[]; fired: string[] }> {
  const from = now - thresholds.sampleWindowMs;
  const windowMinutes = thresholds.sampleWindowMs / 60000;
  const checks: string[] = [];
  const fired: string[] = [];

  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(AVG(CASE WHEN latency_ms > 0 THEN latency_ms END), 0) AS avg_lat,
       COALESCE(MAX(latency_ms), 0) AS max_lat
     FROM analyze_requests
     WHERE created_at >= ?`,
  )
    .bind(from)
    .first<{ total: number; errors: number; pending: number; avg_lat: number; max_lat: number }>();

  const errorCodes = await env.DB.prepare(
    `SELECT error_code, COUNT(*) AS n
     FROM analyze_requests
     WHERE created_at >= ? AND status = 'error'
     GROUP BY error_code
     ORDER BY n DESC
     LIMIT 3`,
  )
    .bind(from)
    .all<{ error_code: string | null; n: number }>();

  const unexpectedProviders = await env.DB.prepare(
    `SELECT a.id AS app_id, a.name AS app_name, COUNT(*) AS n, MAX(r.created_at) AS latest_at
     FROM analyze_requests r
     JOIN apps a ON a.id = r.app_id
     WHERE r.created_at >= ?
       AND a.provider_strategy = 'grok'
       AND r.provider = 'gemini'
     GROUP BY a.id, a.name
     ORDER BY n DESC
     LIMIT 5`,
  )
    .bind(from)
    .all<{ app_id: string; app_name: string | null; n: number; latest_at: number | null }>();

  const unexpectedTotal = unexpectedProviders.results.reduce((sum, r) => sum + Number(r.n || 0), 0);
  checks.push(`analyze grok_strategy_gemini=${unexpectedTotal}`);
  if (unexpectedTotal > 0) {
    const ok = await sendTelegramAlert(
      env,
      {
        title: "ai-guard · analyze provider route mismatch",
        level: "crit",
        lines: [
          `Window: last ${windowMinutes} minutes`,
          `Requests on Gemini despite provider_strategy=grok: ${unexpectedTotal}`,
          `Apps: ${formatUnexpectedProviders(unexpectedProviders.results)}`,
          "Expected: xAI/Grok only; no Gemini fallback",
          "Investigate: https://aicenter.1.gay/#/analyze-records",
        ],
        dedupKey: "analyze-grok-strategy-gemini",
        dedupTtlSeconds: 900,
      },
      env.DEDUP_CACHE,
    );
    if (ok) fired.push("analyze-provider-mismatch");
  }

  if (!row || row.total < thresholds.analyzeMinSample) {
    checks.push(`analyze samples=${row?.total ?? 0} < min=${thresholds.analyzeMinSample} -> skip rate`);
  } else {
    const errRatePct = (row.errors / row.total) * 100;
    checks.push(
      `analyze total=${row.total} errors=${row.errors} pending=${row.pending} ` +
      `err_rate=${errRatePct.toFixed(2)}% max_lat=${row.max_lat}ms`,
    );

    if (errRatePct >= thresholds.analyzeErrorRatePct) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze 错误率告警",
          level: errRatePct >= 20 ? "crit" : "warn",
          lines: [
            `时间窗口: 最近 ${windowMinutes} 分钟`,
            `请求总数: ${row.total}`,
            `错误数: ${row.errors}`,
            `错误率: ${errRatePct.toFixed(2)}%（阈值 ${thresholds.analyzeErrorRatePct}%）`,
            `错误码: ${formatErrorCodes(errorCodes.results) || "none"}`,
            ``,
            `排查: https://aicenter.1.gay/#/analyze-records?status=error`,
          ],
          dedupKey: `analyze-error-rate-${Math.floor(errRatePct / 5)}`,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("analyze-error-rate");
    }

    if (row.max_lat >= thresholds.analyzeLatencyMs) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze 延迟告警",
          level: "warn",
          lines: [
            `时间窗口: 最近 ${windowMinutes} 分钟`,
            `最高延迟: ${row.max_lat}ms（阈值 ${thresholds.analyzeLatencyMs}ms）`,
            `平均延迟: ${Math.round(row.avg_lat)}ms`,
            `样本数: ${row.total}`,
            `排查: https://aicenter.1.gay/#/analyze-ops`,
          ],
          dedupKey: "analyze-latency-high",
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("analyze-latency");
    }
  }

  const backlogFrom = now - thresholds.analyzeBacklogWindowMs;
  const pendingCutoff = now - thresholds.analyzePendingOlderThanMs;
  const pullCutoff = now - thresholds.analyzePullUnackedOlderThanMs;
  const callbackCutoff = now - thresholds.analyzeCallbackUndeliveredOlderThanMs;
  const backlog = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' AND created_at < ? THEN 1 ELSE 0 END), 0) AS pending_older,
       MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at,
       COALESCE(SUM(CASE WHEN status IN ('ok','error') AND acked_at IS NULL AND created_at < ? AND (
         delivery_mode = 'pull' OR (delivery_mode = 'both' AND delivered_at IS NULL)
       ) THEN 1 ELSE 0 END), 0) AS pull_unacked_older,
       MIN(CASE WHEN status IN ('ok','error') AND acked_at IS NULL AND (
         delivery_mode = 'pull' OR (delivery_mode = 'both' AND delivered_at IS NULL)
       ) THEN created_at END) AS oldest_pull_unacked_at,
       COALESCE(SUM(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS callback_undelivered_older,
       MIN(CASE WHEN status IN ('ok','error') AND delivery_mode IN ('callback','both') AND delivered_at IS NULL THEN created_at END) AS oldest_callback_undelivered_at
     FROM analyze_requests
     WHERE created_at >= ?`,
  )
    .bind(pendingCutoff, pullCutoff, callbackCutoff, backlogFrom)
    .first<{
      pending_older: number;
      oldest_pending_at: number | null;
      pull_unacked_older: number;
      oldest_pull_unacked_at: number | null;
      callback_undelivered_older: number;
      oldest_callback_undelivered_at: number | null;
    }>();
  if (!backlog) return { checks, fired };

  checks.push(
    `analyze backlog pending>${formatDuration(thresholds.analyzePendingOlderThanMs)}=${backlog.pending_older} ` +
    `pull_unacked>${formatDuration(thresholds.analyzePullUnackedOlderThanMs)}=${backlog.pull_unacked_older} ` +
    `callback_undelivered>${formatDuration(thresholds.analyzeCallbackUndeliveredOlderThanMs)}=${backlog.callback_undelivered_older}`,
  );

  if (backlog.pending_older > 0) {
    const ok = await sendTelegramAlert(
      env,
      {
        title: "ai-guard · analyze pending 超时",
        level: backlog.pending_older >= 10 ? "crit" : "warn",
        lines: [
          `超时请求数: ${backlog.pending_older}`,
          `阈值: pending > ${formatDuration(thresholds.analyzePendingOlderThanMs)}`,
          `最老 pending: ${formatTimestamp(backlog.oldest_pending_at)}`,
          `排查: https://aicenter.1.gay/#/analyze-records?status=pending`,
        ],
        dedupKey: "analyze-pending-timeout",
        dedupTtlSeconds: 900,
      },
      env.DEDUP_CACHE,
    );
    if (ok) fired.push("analyze-pending-timeout");
  }

  if (backlog.pull_unacked_older >= thresholds.analyzePullUnackedMinCount) {
    const ok = await sendTelegramAlert(
      env,
      {
        title: "ai-guard · analyze pull ack 积压",
        level: backlog.pull_unacked_older >= thresholds.analyzePullUnackedMinCount * 5 ? "crit" : "warn",
        lines: [
          `未 ack 请求数: ${backlog.pull_unacked_older}`,
          `阈值: ${thresholds.analyzePullUnackedMinCount} 条且超过 ${formatDuration(thresholds.analyzePullUnackedOlderThanMs)}`,
          `最老未 ack: ${formatTimestamp(backlog.oldest_pull_unacked_at)}`,
          `排查 IRC pull/ack: https://aicenter.1.gay/#/analyze-ops`,
        ],
        dedupKey: "analyze-pull-unacked",
        dedupTtlSeconds: 1800,
      },
      env.DEDUP_CACHE,
    );
    if (ok) fired.push("analyze-pull-unacked");
  }

  if (backlog.callback_undelivered_older >= thresholds.analyzeCallbackUndeliveredMinCount) {
    const ok = await sendTelegramAlert(
      env,
      {
        title: "ai-guard · analyze callback 未投递",
        level: "warn",
        lines: [
          `未投递请求数: ${backlog.callback_undelivered_older}`,
          `阈值: ${thresholds.analyzeCallbackUndeliveredMinCount} 条且超过 ${formatDuration(thresholds.analyzeCallbackUndeliveredOlderThanMs)}`,
          `最老未投递: ${formatTimestamp(backlog.oldest_callback_undelivered_at)}`,
          `排查: https://aicenter.1.gay/#/callbacks?failed=1`,
        ],
        dedupKey: "analyze-callback-undelivered",
        dedupTtlSeconds: 1800,
      },
      env.DEDUP_CACHE,
    );
    if (ok) fired.push("analyze-callback-undelivered");
  }

  return { checks, fired };
}

function formatErrorCodes(rows: Array<{ error_code: string | null; n: number }>): string {
  return rows.map((r) => `${r.error_code ?? "unknown"}=${r.n}`).join(", ");
}

function formatUnexpectedProviders(
  rows: Array<{ app_id: string; app_name: string | null; n: number; latest_at: number | null }>,
): string {
  return rows
    .map((r) => `${r.app_name || r.app_id}=${r.n} latest=${formatTimestamp(r.latest_at)}`)
    .join(", ");
}

function formatTimestamp(ms: number | null): string {
  return ms ? new Date(ms).toISOString() : "none";
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
