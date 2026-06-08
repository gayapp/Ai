/** Telegram 告警模块 —— 基于 Bot API sendMessage。
 *  仅当 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 两个 secret 都配置了才生效。
 *  未配置时所有告警调用都是 no-op（返回 false），不报错。
 */
import { BACKPRESSURE_HARD_LIMIT, PENDING_COUNT_KV_KEY } from "../analyze/backpressure.ts";

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
  sampleWindowMs: number; // analyze 用 5 * 60 * 1000
  moderationSampleWindowMs: number; // moderation 流量稀疏，30min 窗口给足样本
  minSample: number;      // moderation 最少样本
  minErrorCount: number;  // moderation 触发错误率告警的绝对最小错误数（防低流量假阳）
  dlqNonEmpty: boolean;   // fire on any DLQ content
  analyzeErrorRatePct: number;
  analyzeLatencyMs: number;
  analyzeMinSample: number;
  analyzeMinErrorCount: number; // analyze 触发错误率告警的绝对最小错误数
  analyzePendingOlderThanMs: number;
  analyzePullUnackedOlderThanMs: number;
  analyzePullUnackedMinCount: number;
  analyzeCallbackUndeliveredOlderThanMs: number;
  analyzeCallbackUndeliveredMinCount: number;
  analyzeBacklogWindowMs: number;
  analyzeCacheHitMinPct: number;     // analyze cache hit rate 24h 低于该 % 报警
  analyzeCacheHitWindowMs: number;   // cache hit 计算窗口
  analyzeCacheHitMinSample: number;  // 总单数 < 该值不告警（防低流量假阳）
  moderationZeroTrafficWindowMs: number; // M7：6h 内 moderation total=0 → info 告警
  moderationZeroTrafficEnabled: boolean;
  analyzeSawToothWindowMs: number;        // M14：滑动窗（默认 3h）
  analyzeSawToothSlowThresholdMs: number; // 完成耗时超此值算"慢请求"（默认 5min）
  analyzeSawToothMinCount: number;        // 慢请求数 ≥ 该值告警（默认 50）
  analyzePendingPoolHardLimit: number;    // M3：与 backpressure.ts 同源（final=500）
  analyzePendingPoolWarnPct: number;      // count > hardLimit*该比例 → warn 告警
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  errorRatePct: 5,
  p95LatencyMs: 15_000,
  sampleWindowMs: 5 * 60 * 1000,
  moderationSampleWindowMs: 30 * 60 * 1000,
  minSample: 5,
  minErrorCount: 2,
  dlqNonEmpty: true,
  analyzeErrorRatePct: 5,
  analyzeLatencyMs: 90_000,
  analyzeMinSample: 20,
  analyzeMinErrorCount: 2,
  analyzePendingOlderThanMs: 5 * 60 * 1000,
  analyzePullUnackedOlderThanMs: 2 * 60 * 60 * 1000,
  analyzePullUnackedMinCount: 20,
  analyzeCallbackUndeliveredOlderThanMs: 30 * 60 * 1000,
  analyzeCallbackUndeliveredMinCount: 1,
  analyzeBacklogWindowMs: 24 * 60 * 60 * 1000,
  analyzeCacheHitMinPct: 30,
  analyzeCacheHitWindowMs: 24 * 60 * 60 * 1000,
  analyzeCacheHitMinSample: 100,
  moderationZeroTrafficWindowMs: 6 * 60 * 60 * 1000,
  moderationZeroTrafficEnabled: true,
  analyzeSawToothWindowMs: 3 * 60 * 60 * 1000,
  analyzeSawToothSlowThresholdMs: 5 * 60 * 1000,
  analyzeSawToothMinCount: 50,
  analyzePendingPoolHardLimit: BACKPRESSURE_HARD_LIMIT,
  analyzePendingPoolWarnPct: 0.6,
};

export async function checkAndAlert(
  env: Env,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): Promise<{ checks: string[]; fired: string[] }> {
  const now = Date.now();
  const moderationWindow = thresholds.moderationSampleWindowMs ?? thresholds.sampleWindowMs;
  const from = now - moderationWindow;

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

    if (errRatePct >= thresholds.errorRatePct && row.errors >= thresholds.minErrorCount) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · 错误率告警",
          level: errRatePct >= 20 ? "crit" : "warn",
          lines: [
            `时间窗口: 最近 ${Math.round(moderationWindow / 60000)} 分钟`,
            `请求总数: ${row.total}`,
            `错误数: ${row.errors}`,
            `错误率: ${errRatePct.toFixed(2)}%（阈值 ${thresholds.errorRatePct}%，min_errors=${thresholds.minErrorCount}）`,
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
            `时间窗口: 最近 ${Math.round(moderationWindow / 60000)} 分钟`,
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

  // M7: 6h 滚动窗内 moderation 总量 = 0 → info 级告警，提示上游集成可能断了
  //   （HMAC 失效 / DNS / 客户端 bug 等）。流量稀疏时正常 0-7 单/30min，但 6h 0 单极罕见。
  if (thresholds.moderationZeroTrafficEnabled) {
    const zeroFrom = now - thresholds.moderationZeroTrafficWindowMs;
    const zeroRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM moderation_requests WHERE created_at >= ?`,
    )
      .bind(zeroFrom)
      .first<{ total: number }>();
    const total6h = zeroRow?.total ?? 0;
    const windowHours = Math.round(thresholds.moderationZeroTrafficWindowMs / 3600_000);
    checks.push(`moderation_zero_traffic_${windowHours}h=${total6h}`);
    if (total6h === 0) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · moderation 长时间零流量",
          level: "info",
          lines: [
            `窗口: 最近 ${windowHours} 小时`,
            `moderation 请求总数: 0`,
            ``,
            `可能原因：上游 app 集成断（HMAC 失效 / DNS / 客户端 bug），或所有 app 处于自然安静期。`,
            `如果业务侧确认有流量进来，需要排查 app HMAC 凭据 + ai-guard 入口路由。`,
          ],
          dedupKey: `moderation-zero-traffic-${windowHours}h`,
          dedupTtlSeconds: thresholds.moderationZeroTrafficWindowMs / 1000,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("moderation-zero-traffic");
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

    if (errRatePct >= thresholds.analyzeErrorRatePct && row.errors >= thresholds.analyzeMinErrorCount) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze 错误率告警",
          level: errRatePct >= 20 ? "crit" : "warn",
          lines: [
            `时间窗口: 最近 ${windowMinutes} 分钟`,
            `请求总数: ${row.total}`,
            `错误数: ${row.errors}`,
            `错误率: ${errRatePct.toFixed(2)}%（阈值 ${thresholds.analyzeErrorRatePct}%，min_errors=${thresholds.analyzeMinErrorCount}）`,
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
       COALESCE(SUM(CASE WHEN status IN ('ok','error') AND acked_at IS NULL AND created_at < ?
         AND delivery_mode IN ('pull','both')
       THEN 1 ELSE 0 END), 0) AS pull_unacked_older,
       MIN(CASE WHEN status IN ('ok','error') AND acked_at IS NULL
         AND delivery_mode IN ('pull','both')
       THEN created_at END) AS oldest_pull_unacked_at,
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

  // M26: cache hit rate 是隐性成本基线。analyze 高峰期常态 50-90% cache hit；
  //   若 KV 故障 / dedup key bug / TTL 配置错，hit% 会瞬间塌到 0%，token cost 暴涨 10x+。
  //   只在样本量足够时检查（minSample 防低流量假阳）。dedupTtl=1h，避免每 5min 重复推。
  const cacheFrom = now - thresholds.analyzeCacheHitWindowMs;
  const cacheRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) AS cached_n
     FROM analyze_requests
     WHERE created_at >= ?`,
  )
    .bind(cacheFrom)
    .first<{ total: number; cached_n: number }>();

  if (cacheRow && cacheRow.total >= thresholds.analyzeCacheHitMinSample) {
    const hitPct = (cacheRow.cached_n / cacheRow.total) * 100;
    checks.push(
      `analyze cache_hit_${Math.round(thresholds.analyzeCacheHitWindowMs / 3600_000)}h=${hitPct.toFixed(1)}% (${cacheRow.cached_n}/${cacheRow.total})`,
    );
    if (hitPct < thresholds.analyzeCacheHitMinPct) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze cache hit rate 异常偏低",
          level: hitPct < thresholds.analyzeCacheHitMinPct / 3 ? "crit" : "warn",
          lines: [
            `cache hit: ${hitPct.toFixed(2)}%（阈值 ${thresholds.analyzeCacheHitMinPct}%）`,
            `窗口: 最近 ${Math.round(thresholds.analyzeCacheHitWindowMs / 3600_000)} 小时`,
            `命中数: ${cacheRow.cached_n} / 总单: ${cacheRow.total}`,
            ``,
            `常态：50-90%。骤降通常代表 KV/DEDUP_CACHE 链路故障、dedup key 算法变更，`,
            `或 prompt 升级触发全局失效。token 成本会按 (1 / 当前命中) 倍数上涨。`,
            ``,
            `排查: https://aicenter.1.gay/#/analyze-ops`,
          ],
          dedupKey: "analyze-cache-hit-low",
          dedupTtlSeconds: 3600,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("analyze-cache-hit-low");
    }
  } else {
    checks.push(`analyze cache_hit samples=${cacheRow?.total ?? 0} < min=${thresholds.analyzeCacheHitMinSample} -> skip`);
  }

  // M14: chronic saw-tooth — 3h 内 ok 请求里耗时 > 5min 的数量。M17 数据印证 vision
  //   工作负载 avg ~10s 是新基线，max 60-90s 偶发；但 2026-05-26 那次 33min partial
  //   degraded 全程错误率 0%（队列重试覆盖），现有阈值告警全部静默。完成耗时是检测
  //   xAI 平台层 partial degradation 的代理。dedupTtl=1h，避免每 5min 重复推。
  const sawToothFrom = now - thresholds.analyzeSawToothWindowMs;
  const sawToothRow = await env.DB.prepare(
    `SELECT COUNT(*) AS slow_n FROM analyze_requests
     WHERE completed_at > ?
       AND status = 'ok' AND cached = 0
       AND completed_at - created_at > ?`,
  )
    .bind(sawToothFrom, thresholds.analyzeSawToothSlowThresholdMs)
    .first<{ slow_n: number }>();
  const slowN = sawToothRow?.slow_n ?? 0;
  const sawWindowHours = Math.round(thresholds.analyzeSawToothWindowMs / 3600_000);
  const slowMinutes = Math.round(thresholds.analyzeSawToothSlowThresholdMs / 60_000);
  checks.push(`analyze sawtooth_${sawWindowHours}h_slow${slowMinutes}m=${slowN}`);
  if (slowN >= thresholds.analyzeSawToothMinCount) {
    const ok = await sendTelegramAlert(
      env,
      {
        title: "ai-guard · analyze 长尾慢请求（疑似 xAI partial degraded）",
        level: "warn",
        lines: [
          `窗口: 最近 ${sawWindowHours} 小时`,
          `慢请求数: ${slowN}（阈值 ${thresholds.analyzeSawToothMinCount}）`,
          `判定: completed_at - created_at > ${slowMinutes} 分钟，status=ok cached=0`,
          ``,
          `常态：vision 工作负载 avg ~10s，max 60-90s 偶发。若 3h 内 ≥50 次超 5min 完成，`,
          `通常代表 xAI 进入 partial degraded（成功率虽然没掉到 0，但延迟拉长）。`,
          `业务影响：IRC 异步拉取等待变长（秒级→分钟级），错误率维持 0% 但体验明显劣化。`,
          ``,
          `排查: https://aicenter.1.gay/#/analyze-ops`,
        ],
        dedupKey: "analyze-sawtooth-chronic",
        dedupTtlSeconds: 3600,
      },
      env.DEDUP_CACHE,
    );
    if (ok) fired.push("analyze-sawtooth-chronic");
  }

  // M3: pending pool 容量告警。读 cron 写入的 KV 缓存（不二次查 D1）。
  //   ≥ warnPct → warn（"接近背压阈值"），≥ hardLimit → crit（"正在拒请求"）。
  try {
    const raw = await env.NONCE.get(PENDING_COUNT_KV_KEY);
    const poolCount = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    const hardLimit = thresholds.analyzePendingPoolHardLimit;
    const warnThreshold = Math.floor(hardLimit * thresholds.analyzePendingPoolWarnPct);
    checks.push(`analyze pending_pool=${poolCount}/${hardLimit} (warn>=${warnThreshold})`);

    if (poolCount >= hardLimit) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze pending pool 满载（正在拒请求）",
          level: "crit",
          lines: [
            `pending 池: ${poolCount} / ${hardLimit}（100%+）`,
            `状态：ai-guard 正在向 IRC 返回 503 backlog_overload`,
            ``,
            `通常代表 xAI 长时间 down 中，IRC 在持久队列里慢重投。`,
            `如果是预期的事故响应，可忽略。如果意外，检查 provider-health。`,
            `RFC：docs/optimization/m3-rfc-pending-pool-backpressure.md`,
          ],
          dedupKey: "analyze-pending-pool-full",
          dedupTtlSeconds: 3600,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("analyze-pending-pool-full");
    } else if (poolCount >= warnThreshold) {
      const ok = await sendTelegramAlert(
        env,
        {
          title: "ai-guard · analyze pending pool 接近阈值",
          level: "warn",
          lines: [
            `pending 池: ${poolCount} / ${hardLimit}（${Math.round((poolCount / hardLimit) * 100)}%）`,
            `阈值：≥ ${warnThreshold}（${Math.round(thresholds.analyzePendingPoolWarnPct * 100)}%）`,
            ``,
            `还未拒请求，但 provider 端可能在变慢。`,
            `观察 [analyze-ops 看板](https://aicenter.1.gay/#/analyze-ops)，若涨势持续准备 incident。`,
          ],
          dedupKey: "analyze-pending-pool-warn",
          dedupTtlSeconds: 3600,
        },
        env.DEDUP_CACHE,
      );
      if (ok) fired.push("analyze-pending-pool-warn");
    }
  } catch (e) {
    console.warn("[alert] pending pool check failed", e);
  }

  return { checks, fired };
}

/**
 * 周心跳：证明告警通路（Telegram + KV dedup）活着。
 * scheduled handler 每日调用，dedup ~6.5 天 → 实际 1 周一条。
 * 若哪天 sendTelegramAlert 静默坏掉、KV 不通，就再也收不到这条；
 * 也是用户判断"是真的安静还是告警死了"的唯一依据。
 */
export async function sendWeeklyHeartbeat(env: Env): Promise<boolean> {
  return sendTelegramAlert(
    env,
    {
      title: "ai-guard · 告警通路心跳",
      level: "info",
      lines: [
        "看到这条 = Telegram + KV dedup + scheduled cron 都活着 ✅",
        "下一条心跳约 7 天后。",
      ],
      dedupKey: "alert-heartbeat-weekly",
      dedupTtlSeconds: 6 * 24 * 3600 + 12 * 3600,
    },
    env.DEDUP_CACHE,
  );
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
