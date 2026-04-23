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

import type { Provider } from "../moderation/schema.ts";

const FAIL_THRESHOLD = 5;
const OPEN_SECONDS = 30;

interface CircuitState {
  failures: number;
  openUntil: number; // unix ms, 0 = closed
  lastFailure: number; // unix ms
}

function key(provider: Provider): string {
  return `cb:${provider}`;
}

async function load(kv: KVNamespace, provider: Provider): Promise<CircuitState> {
  const raw = await kv.get(key(provider));
  if (!raw) return { failures: 0, openUntil: 0, lastFailure: 0 };
  try {
    return JSON.parse(raw) as CircuitState;
  } catch {
    return { failures: 0, openUntil: 0, lastFailure: 0 };
  }
}

async function save(kv: KVNamespace, provider: Provider, s: CircuitState): Promise<void> {
  // TTL >= 60s is CF KV minimum. We keep 300s so stale state auto-clears.
  await kv.put(key(provider), JSON.stringify(s), { expirationTtl: 300 });
}

/** Decide whether a provider can be tried now. */
export async function canTry(kv: KVNamespace, provider: Provider): Promise<boolean> {
  const s = await load(kv, provider);
  if (s.openUntil === 0) return true;
  if (Date.now() >= s.openUntil) return true; // half-open — allow one try
  return false;
}

export async function recordSuccess(kv: KVNamespace, provider: Provider): Promise<void> {
  const s = await load(kv, provider);
  if (s.failures !== 0 || s.openUntil !== 0) {
    await save(kv, provider, { failures: 0, openUntil: 0, lastFailure: s.lastFailure });
  }
}

export async function recordFailure(kv: KVNamespace, provider: Provider): Promise<void> {
  const s = await load(kv, provider);
  const now = Date.now();
  // If previous failure was >60s ago, start counting fresh
  const failures = now - s.lastFailure > 60_000 ? 1 : s.failures + 1;
  const openUntil = failures >= FAIL_THRESHOLD ? now + OPEN_SECONDS * 1000 : s.openUntil;
  await save(kv, provider, { failures, openUntil, lastFailure: now });
}

export async function getCircuitSnapshot(kv: KVNamespace): Promise<Record<Provider, CircuitState>> {
  const [g, gm] = await Promise.all([load(kv, "grok"), load(kv, "gemini")]);
  return { grok: g, gemini: gm };
}
