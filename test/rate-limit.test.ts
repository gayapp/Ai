import { describe, expect, it, beforeEach } from "vitest";
import { checkRateLimit } from "../src/auth/rate-limit.ts";

/** Minimal in-memory KV stub that satisfies the subset we use. */
class MemKV {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
  async delete(k: string): Promise<void> { this.m.delete(k); }
}

describe("rate limit", () => {
  let kv: MemKV;
  beforeEach(() => { kv = new MemKV(); });

  it("allows first N within limit", async () => {
    const r1 = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 3);
    const r2 = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 3);
    const r3 = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 3);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r3.current).toBe(3);
  });

  it("blocks beyond limit", async () => {
    await checkRateLimit(kv as unknown as KVNamespace, "app_1", 2);
    await checkRateLimit(kv as unknown as KVNamespace, "app_1", 2);
    const over = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 2);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates per-app counters", async () => {
    await checkRateLimit(kv as unknown as KVNamespace, "app_1", 1);
    const blockedA = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 1);
    const allowedB = await checkRateLimit(kv as unknown as KVNamespace, "app_2", 1);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it("limit=0 always blocks", async () => {
    const r = await checkRateLimit(kv as unknown as KVNamespace, "app_1", 0);
    expect(r.allowed).toBe(false);
  });
});
