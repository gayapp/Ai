/**
 * M3 · analyze 入口背压。
 *
 * pending 池超 hard_limit 时入口 503，让 IRC 端把 backlog 搬到自己的持久任务队列
 * 慢重投（见 docs/optimization/m3-rfc-pending-pool-backpressure.md）。
 *
 * pending count 不在每个请求查 D1（70k 行表 SELECT COUNT(*) ~50ms 拉延迟），
 * 而是 cron 每 5 分钟（star/5 ...）写 NONCE KV（TTL 5min），入口 read。容忍 5min 偏差。
 *
 * Phase 2：IRC requeue 路径已通过 controlled prod 503 acceptance，hard_limit 降到 final 500。
 * 详见 ai2ai.md。
 */

import type { Context } from "hono";

/** Final M3 pending-pool hard limit after IRC requeue readiness. */
export const BACKPRESSURE_HARD_LIMIT = 500;
/** ≥ 60% 满载报 severity=warn 给 IRC（供其 Phase 2 主动降速参考） */
export const BACKPRESSURE_WARN_PCT = 0.6;
/** 503 响应里告诉 IRC 多久后重试（秒）。IRC 退回持久队列 + jitter 重投 */
export const RETRY_AFTER_SECONDS = 30;
/** cron 写、入口 read 的 KV key */
export const PENDING_COUNT_KV_KEY = "kv:analyze:pending:count";
/** admin-only one-shot gate prefix for controlled IRC live 503 acceptance. */
export const BACKPRESSURE_CANARY_KV_PREFIX = "kv:analyze:backpressure-canary:";
export const BACKPRESSURE_CANARY_DEFAULT_TTL_SECONDS = 120;
export const BACKPRESSURE_CANARY_MAX_TTL_SECONDS = 300;

export type BacklogSeverity = "ok" | "warn" | "crit";

export interface BackpressureCanaryGate {
  app_id: string;
  biz_type: string;
  biz_id: string;
  reason: string | null;
  armed_by: string;
  armed_at_ms: number;
  expires_at_ms: number;
}

export interface ArmBackpressureCanaryInput {
  appId: string;
  bizType: string;
  bizId: string;
  ttlSeconds?: number;
  reason?: string | null;
  armedBy?: string | null;
}

export interface BackpressureMatchInput {
  appId: string;
  bizType: string;
  bizId: string;
}

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

export function backpressureCanaryKey(appId: string): string {
  return `${BACKPRESSURE_CANARY_KV_PREFIX}${appId}`;
}

export async function armBackpressureCanary(
  env: Env,
  input: ArmBackpressureCanaryInput,
): Promise<BackpressureCanaryGate> {
  const now = Date.now();
  const ttlSeconds = clampCanaryTtl(input.ttlSeconds);
  const gate: BackpressureCanaryGate = {
    app_id: input.appId,
    biz_type: input.bizType,
    biz_id: input.bizId,
    reason: input.reason?.trim() || null,
    armed_by: input.armedBy?.trim() || "admin",
    armed_at_ms: now,
    expires_at_ms: now + ttlSeconds * 1000,
  };
  await env.NONCE.put(backpressureCanaryKey(input.appId), JSON.stringify(gate), {
    expirationTtl: ttlSeconds,
  });
  return gate;
}

export async function getBackpressureCanary(
  env: Env,
  appId: string,
): Promise<BackpressureCanaryGate | null> {
  const key = backpressureCanaryKey(appId);
  const raw = await env.NONCE.get(key);
  if (!raw) return null;
  const gate = parseBackpressureCanary(raw);
  if (!gate || gate.expires_at_ms <= Date.now()) {
    await env.NONCE.delete(key);
    return null;
  }
  return gate;
}

export async function clearBackpressureCanary(env: Env, appId: string): Promise<void> {
  await env.NONCE.delete(backpressureCanaryKey(appId));
}

async function consumeMatchingBackpressureCanary(
  env: Env,
  input: BackpressureMatchInput,
): Promise<BackpressureCanaryGate | null> {
  const gate = await getBackpressureCanary(env, input.appId);
  if (!gate) return null;
  if (
    gate.app_id !== input.appId ||
    gate.biz_type !== input.bizType ||
    gate.biz_id !== input.bizId
  ) {
    return null;
  }
  await clearBackpressureCanary(env, input.appId);
  return gate;
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
  matchInput?: BackpressureMatchInput,
): Promise<Response | null> {
  const count = await getPendingCountCached(c.env);
  let currentBacklog = count;
  let severity = getBacklogSeverity(count, hardLimit);
  let canaryGate: BackpressureCanaryGate | null = null;

  if (severity !== "crit" && matchInput) {
    canaryGate = await consumeMatchingBackpressureCanary(c.env, matchInput);
    if (canaryGate) {
      currentBacklog = Math.max(count, hardLimit + 1);
      severity = "crit";
    }
  }

  c.header("X-Analyze-Backlog", String(currentBacklog));
  c.header("X-Analyze-Backlog-Severity", severity);
  if (canaryGate) c.header("X-Analyze-Backpressure-Canary", "1");

  if (severity === "crit") {
    return c.json(
      {
        error_code: "backlog_overload",
        message: "analyze backlog exceeded; retry after the indicated seconds",
        retry_after_seconds: RETRY_AFTER_SECONDS,
        current_backlog: currentBacklog,
        hard_limit: hardLimit,
        ...(canaryGate ? { canary: true } : {}),
      },
      503,
    );
  }
  return null;
}

function clampCanaryTtl(ttlSeconds: number | undefined): number {
  if (!ttlSeconds) return BACKPRESSURE_CANARY_DEFAULT_TTL_SECONDS;
  return Math.min(
    BACKPRESSURE_CANARY_MAX_TTL_SECONDS,
    Math.max(1, Math.floor(ttlSeconds)),
  );
}

function parseBackpressureCanary(raw: string): BackpressureCanaryGate | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BackpressureCanaryGate>;
    if (
      typeof parsed.app_id !== "string" ||
      typeof parsed.biz_type !== "string" ||
      typeof parsed.biz_id !== "string" ||
      typeof parsed.armed_by !== "string" ||
      typeof parsed.armed_at_ms !== "number" ||
      typeof parsed.expires_at_ms !== "number"
    ) {
      return null;
    }
    return {
      app_id: parsed.app_id,
      biz_type: parsed.biz_type,
      biz_id: parsed.biz_id,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      armed_by: parsed.armed_by,
      armed_at_ms: parsed.armed_at_ms,
      expires_at_ms: parsed.expires_at_ms,
    };
  } catch {
    return null;
  }
}
