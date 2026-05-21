/** KV-backed circuit breaker per provider.
 *
 *  状态：closed（正常）/ open（断）/ half-open（试探）
 *  存在 KV NONCE namespace 里（复用，key 前缀 `cb:`）
 *
 *  规则：
 *  - 连续失败 ≥ FAIL_THRESHOLD 次 → open 30s
 *  - open 期间：直接拒绝，不打上游
 *  - open 过后 → half-open，放一个请求探，成功→closed 失败→open 再 30s
 *
 *  KV 最终一致性导致计数可能小有偏差，但对"整体 provider 挂了"这种场景够用。
 */

import type { AnalyzeBizType, AnalyzeProvider } from "../analyze/types.ts";
import type { Provider } from "../moderation/schema.ts";

const FAIL_THRESHOLD = 5;
const OPEN_SECONDS = 30;
/** Auth 错误立即长开熔断，避免继续空耗 Token 并放大告警 */
export const AUTH_OPEN_SECONDS = 600; // 10 分钟

interface CircuitState {
  failures: number;
  openUntil: number; // unix ms, 0 = closed
  lastFailure: number; // unix ms
}

type CircuitProvider = Provider | AnalyzeProvider;
type KnownCircuitProvider = "grok" | "gemini" | "xai";

export interface CircuitSnapshot {
  provider: KnownCircuitProvider;
  biz_type: AnalyzeBizType | null;
  failures: number;
  open_until: string | null;
  last_failure_at: string | null;
  state: "closed" | "open" | "half_open";
  seconds_to_close: number;
}

function key(provider: CircuitProvider, bizType?: AnalyzeBizType): string {
  return bizType ? `cb:${provider}:${bizType}` : `cb:${provider}`;
}

async function load(
  kv: KVNamespace,
  provider: CircuitProvider,
  bizType?: AnalyzeBizType,
): Promise<CircuitState> {
  const raw = await kv.get(key(provider, bizType));
  if (!raw) return { failures: 0, openUntil: 0, lastFailure: 0 };
  try {
    return JSON.parse(raw) as CircuitState;
  } catch {
    return { failures: 0, openUntil: 0, lastFailure: 0 };
  }
}

async function save(
  kv: KVNamespace,
  provider: CircuitProvider,
  s: CircuitState,
  bizType?: AnalyzeBizType,
): Promise<void> {
  // TTL >= 60s is CF KV minimum. We keep 300s so stale state auto-clears.
  await kv.put(key(provider, bizType), JSON.stringify(s), { expirationTtl: 300 });
}

/** Decide whether a provider can be tried now. */
export async function canTry(
  kv: KVNamespace,
  provider: CircuitProvider,
  bizType?: AnalyzeBizType,
): Promise<boolean> {
  const s = await load(kv, provider, bizType);
  if (s.openUntil === 0) return true;
  if (Date.now() >= s.openUntil) return true; // half-open — allow one try
  return false;
}

export async function recordSuccess(
  kv: KVNamespace,
  provider: CircuitProvider,
  bizType?: AnalyzeBizType,
): Promise<void> {
  const s = await load(kv, provider, bizType);
  if (s.failures !== 0 || s.openUntil !== 0) {
    await save(kv, provider, { failures: 0, openUntil: 0, lastFailure: s.lastFailure }, bizType);
  }
}

export async function recordFailure(
  kv: KVNamespace,
  provider: CircuitProvider,
  bizType?: AnalyzeBizType,
): Promise<void> {
  const s = await load(kv, provider, bizType);
  const now = Date.now();
  // If previous failure was >60s ago, start counting fresh
  const failures = now - s.lastFailure > 60_000 ? 1 : s.failures + 1;
  const openUntil = failures >= FAIL_THRESHOLD ? now + OPEN_SECONDS * 1000 : s.openUntil;
  await save(kv, provider, { failures, openUntil, lastFailure: now }, bizType);
}

/** Auth 错误立即开长熔断（10 分钟），不需要攒 5 次 */
export async function recordAuthFailure(
  kv: KVNamespace,
  provider: CircuitProvider,
  bizType?: AnalyzeBizType,
): Promise<void> {
  const now = Date.now();
  await save(kv, provider, {
    failures: FAIL_THRESHOLD,
    openUntil: now + AUTH_OPEN_SECONDS * 1000,
    lastFailure: now,
  }, bizType);
}

export async function getCircuitSnapshot(kv: KVNamespace): Promise<CircuitSnapshot[]> {
  const now = Date.now();
  const providers: KnownCircuitProvider[] = ["grok", "gemini", "xai"];
  const analyzeBizTypes: AnalyzeBizType[] = ["media_analysis", "media_intro"];
  const keys: Array<{ provider: KnownCircuitProvider; bizType?: AnalyzeBizType }> = [
    ...providers.map((provider) => ({ provider })),
    ...(["gemini", "xai"] as KnownCircuitProvider[]).flatMap((provider) =>
      analyzeBizTypes.map((bizType) => ({ provider, bizType })),
    ),
  ];
  const states = await Promise.all(
    keys.map(async (item) => ({
      ...item,
      state: await load(kv, item.provider, item.bizType),
    })),
  );
  return states.map(({ provider, bizType, state }) => {
    const open = state.openUntil > now;
    const halfOpen = state.openUntil > 0 && state.openUntil <= now;
    return {
      provider,
      biz_type: bizType ?? null,
      failures: state.failures,
      open_until: state.openUntil ? new Date(state.openUntil).toISOString() : null,
      last_failure_at: state.lastFailure ? new Date(state.lastFailure).toISOString() : null,
      state: open ? "open" : halfOpen ? "half_open" : "closed",
      seconds_to_close: open ? Math.ceil((state.openUntil - now) / 1000) : 0,
    };
  });
}
