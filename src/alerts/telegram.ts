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
    await kv.put(`alert-dedup:${ctx.dedupKey}`, "1", { expirationTtl: 300 });
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
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  errorRatePct: 5,
  p95LatencyMs: 15_000,
  sampleWindowMs: 5 * 60 * 1000,
  minSample: 20,
  dlqNonEmpty: true,
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
    checks.push(`window samples=${row?.total ?? 0} < min=${thresholds.minSample} → skip`);
    return { checks, fired };
  }

  const errRatePct = (row.errors / row.total) * 100;
  checks.push(
    `total=${row.total} errors=${row.errors} err_rate=${errRatePct.toFixed(2)}% max_lat=${row.max_lat}ms`,
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

  return { checks, fired };
}
