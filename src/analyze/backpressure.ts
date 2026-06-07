/**
 * M3 · analyze 入口背压。
 *
 * pending 池超 hard_limit 时入口 503，让 IRC 端把 backlog 搬到自己的持久任务队列
 * 慢重投（见 docs/optimization/m3-rfc-pending-pool-backpressure.md）。
 *
 * pending count 不在每个请求查 D1（70k 行表 SELECT COUNT(*) ~50ms 拉延迟），
 * 而是 cron 每 5 分钟（star/5 ...）写 NONCE KV（TTL 5min），入口 read。容忍 5min 偏差。
 *
 * Phase 1（canary）：hard_limit=2000，稳态 < 50 不会触发；等 IRC requeue 路径上 prod
 * 后 lower 到 final 500。详见 ai2ai.md。
 */

import type { Context } from "hono";

/** Phase 1 canary 阈值。Phase 2 IRC requeue ready 后改为 500。 */
export const BACKPRESSURE_HARD_LIMIT = 2000;
/** ≥ 60% 满载报 severity=warn 给 IRC（供其 Phase 2 主动降速参考） */
export const BACKPRESSURE_WARN_PCT = 0.6;
/** 503 响应里告诉 IRC 多久后重试（秒）。IRC 退回持久队列 + jitter 重投 */
export const RETRY_AFTER_SECONDS = 30;
/** cron 写、入口 read 的 KV key */
export const PENDING_COUNT_KV_KEY = "kv:analyze:pending:count";

export type BacklogSeverity = "ok" | "warn" | "crit";

/**
 * 读 NONCE KV 缓存里的 pending 池规模。
 * - 缺失（cron 还没写过）或解析失败 → 返 0（保守视为健康，不拒）
 * - 这是防御：KV 故障不应直接阻断业务，最坏退化成"不背压"
 */
export async function getPendingCountCached(env: Env): Promise<number> {
  try {
    const raw = await env.NONCE.get(PENDING_COUNT_KV_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * count → severity 映射。
 *   count > hardLimit          → crit（同时触发 503 拒绝）
 *   count > hardLimit*warnPct  → warn
 *   otherwise                  → ok
 */
export function getBacklogSeverity(
  count: number,
  hardLimit: number = BACKPRESSURE_HARD_LIMIT,
  warnPct: number = BACKPRESSURE_WARN_PCT,
): BacklogSeverity {
  if (count > hardLimit) return "crit";
  if (count > hardLimit * warnPct) return "warn";
  return "ok";
}

/**
 * 主入口：设 `X-Analyze-Backlog` + `X-Analyze-Backlog-Severity` header；
 * 超 hard_limit 时返 503 Response（路由 `return` 即可），否则返 null（继续处理）。
 *
 * 鉴权 / 限流 / 参数校验之后调，DB 写之前。
 */
export async function enforceBackpressure(
  c: Context<{ Bindings: Env }>,
  hardLimit: number = BACKPRESSURE_HARD_LIMIT,
): Promise<Response | null> {
  const count = await getPendingCountCached(c.env);
  const severity = getBacklogSeverity(count, hardLimit);

  c.header("X-Analyze-Backlog", String(count));
  c.header("X-Analyze-Backlog-Severity", severity);

  if (severity === "crit") {
    return c.json(
      {
        error_code: "backlog_overload",
        message: "analyze backlog exceeded; retry after the indicated seconds",
        retry_after_seconds: RETRY_AFTER_SECONDS,
        current_backlog: count,
        hard_limit: hardLimit,
      },
      503,
    );
  }
  return null;
}
