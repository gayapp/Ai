import { AppError, ErrorCodes } from "../lib/errors.ts";

/**
 * KV-based sliding window rate limiter（以秒为粒度）。
 *
 * 不依赖 Durable Objects。
 * KV 的 eventual consistency 意味着短暂突发可能超限一点点，但软限流可以接受。
 *
 * 用 NONCE KV namespace 寄存计数器（已有、且 TTL 友好）。
 * Key schema: `rl:{app_id}:{epoch_second}`
 */

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  appId: string,
  limit: number,
): Promise<RateLimitResult> {
  if (limit <= 0) {
    return { allowed: false, current: 0, limit: 0, retryAfterSeconds: 60 };
  }
  const sec = Math.floor(Date.now() / 1000);
  const key = `rl:${appId}:${sec}`;

  // Read-modify-write — not atomic, but good enough for soft QPS limits.
  // Under contention the max drift is ~(concurrent_colos × writes_in_flight),
  // which is small relative to the limit for typical traffic.
  const cur = parseInt((await kv.get(key)) ?? "0", 10);

  if (cur >= limit) {
    return { allowed: false, current: cur, limit, retryAfterSeconds: 1 };
  }

  // CF KV minimum TTL is 60s
  await kv.put(key, String(cur + 1), { expirationTtl: 60 });
  return { allowed: true, current: cur + 1, limit, retryAfterSeconds: 0 };
}

export async function enforceRateLimit(
  kv: KVNamespace,
  appId: string,
  limit: number,
): Promise<void> {
  const r = await checkRateLimit(kv, appId, limit);
  if (!r.allowed) {
    throw new AppError(
      ErrorCodes.RATE_LIMITED,
      429,
      `rate limit exceeded: ${r.current}/${r.limit}`,
      { retry_after_seconds: r.retryAfterSeconds },
    );
  }
}
