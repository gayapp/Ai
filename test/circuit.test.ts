import { describe, expect, it } from "vitest";
import {
  AUTH_OPEN_SECONDS,
  canTry,
  recordAuthFailure,
  recordFailure,
  recordSuccess,
} from "../src/providers/circuit.ts";

class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

describe("circuit breaker · M10 fail threshold = 3", () => {
  it("stays closed after 2 failures (under new threshold)", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    await recordFailure(kv, "xai");
    await recordFailure(kv, "xai");
    expect(await canTry(kv, "xai")).toBe(true);
  });

  it("opens after exactly 3 failures (new threshold)", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    await recordFailure(kv, "xai");
    await recordFailure(kv, "xai");
    await recordFailure(kv, "xai");
    expect(await canTry(kv, "xai")).toBe(false);
  });

  it("recordSuccess resets failure count", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    await recordFailure(kv, "grok");
    await recordFailure(kv, "grok");
    await recordSuccess(kv, "grok");
    // After reset, 2 more failures shouldn't trip (was at 0 again)
    await recordFailure(kv, "grok");
    await recordFailure(kv, "grok");
    expect(await canTry(kv, "grok")).toBe(true);
  });

  it("AUTH failure opens immediately on first hit (preserves existing behavior)", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    await recordAuthFailure(kv, "xai");
    expect(await canTry(kv, "xai")).toBe(false);
    // AUTH_OPEN_SECONDS is 600s (10 min); we don't time-travel here, just confirm closed-state
    expect(AUTH_OPEN_SECONDS).toBe(600);
  });

  it("biz-typed circuits are independent", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    await recordFailure(kv, "xai", "media_analysis");
    await recordFailure(kv, "xai", "media_analysis");
    await recordFailure(kv, "xai", "media_analysis");
    expect(await canTry(kv, "xai", "media_analysis")).toBe(false);
    // media_intro circuit untouched
    expect(await canTry(kv, "xai", "media_intro")).toBe(true);
  });
});
