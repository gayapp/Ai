import { describe, expect, it } from "vitest";
import {
  BACKPRESSURE_HARD_LIMIT,
  PENDING_COUNT_KV_KEY,
  RETRY_AFTER_SECONDS,
  armBackpressureCanary,
  enforceBackpressure,
  getBackpressureCanary,
  getBacklogSeverity,
  getPendingCountCached,
} from "../src/analyze/backpressure.ts";

class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface FakeContext {
  env: Env;
  setHeaders: Map<string, string>;
  header(name: string, value: string): void;
  json(body: unknown, status: number): Response;
}

function makeContext(kv: FakeKV): FakeContext {
  const headers = new Map<string, string>();
  return {
    env: { NONCE: kv } as unknown as Env,
    setHeaders: headers,
    header(name: string, value: string): void {
      headers.set(name, value);
    },
    json(body: unknown, status: number): Response {
      const h = new Headers({ "content-type": "application/json" });
      for (const [k, v] of headers) h.set(k, v);
      return new Response(JSON.stringify(body), { status, headers: h });
    },
  };
}

describe("backpressure · severity boundaries", () => {
  it("ok when count is at warn threshold", () => {
    // warnPct=0.6, hardLimit=2000 → warn 阈值 1200。1200 不算超（> 才 warn）
    expect(getBacklogSeverity(1200, 2000, 0.6)).toBe("ok");
  });

  it("warn when count exceeds warnPct", () => {
    expect(getBacklogSeverity(1201, 2000, 0.6)).toBe("warn");
    expect(getBacklogSeverity(1999, 2000, 0.6)).toBe("warn");
  });

  it("crit when count exceeds hardLimit", () => {
    expect(getBacklogSeverity(2001, 2000, 0.6)).toBe("crit");
  });

  it("ok at zero", () => {
    expect(getBacklogSeverity(0, 2000, 0.6)).toBe("ok");
  });
});

describe("backpressure · getPendingCountCached", () => {
  it("returns 0 on KV miss", async () => {
    const kv = new FakeKV();
    const env = { NONCE: kv } as unknown as Env;
    expect(await getPendingCountCached(env)).toBe(0);
  });

  it("parses integer from KV", async () => {
    const kv = new FakeKV();
    await kv.put(PENDING_COUNT_KV_KEY, "150");
    const env = { NONCE: kv } as unknown as Env;
    expect(await getPendingCountCached(env)).toBe(150);
  });

  it("returns 0 on malformed KV value", async () => {
    const kv = new FakeKV();
    await kv.put(PENDING_COUNT_KV_KEY, "not-a-number");
    const env = { NONCE: kv } as unknown as Env;
    expect(await getPendingCountCached(env)).toBe(0);
  });
});

describe("backpressure · enforceBackpressure", () => {
  it("returns null and sets headers when count below limit", async () => {
    const kv = new FakeKV();
    await kv.put(PENDING_COUNT_KV_KEY, "100");
    const ctx = makeContext(kv);
    const result = await enforceBackpressure(ctx as unknown as Parameters<typeof enforceBackpressure>[0]);

    expect(result).toBeNull();
    expect(ctx.setHeaders.get("X-Analyze-Backlog")).toBe("100");
    expect(ctx.setHeaders.get("X-Analyze-Backlog-Severity")).toBe("ok");
  });

  it("returns 503 Response with body + headers when count exceeds limit", async () => {
    const kv = new FakeKV();
    await kv.put(PENDING_COUNT_KV_KEY, String(BACKPRESSURE_HARD_LIMIT + 100));
    const ctx = makeContext(kv);
    const result = await enforceBackpressure(ctx as unknown as Parameters<typeof enforceBackpressure>[0]);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(503);
    const body = (await result!.json()) as {
      error_code: string;
      retry_after_seconds: number;
      current_backlog: number;
      hard_limit: number;
    };
    expect(body.error_code).toBe("backlog_overload");
    expect(body.retry_after_seconds).toBe(RETRY_AFTER_SECONDS);
    expect(body.current_backlog).toBe(BACKPRESSURE_HARD_LIMIT + 100);
    expect(body.hard_limit).toBe(BACKPRESSURE_HARD_LIMIT);
    // header 也应该被写入响应（虽然 c.json 路径里我们手动复制了 headers）
    expect(result!.headers.get("X-Analyze-Backlog")).toBe(String(BACKPRESSURE_HARD_LIMIT + 100));
    expect(result!.headers.get("X-Analyze-Backlog-Severity")).toBe("crit");
  });

  it("sets severity=warn at the warn band without rejecting", async () => {
    const kv = new FakeKV();
    // 70% 在 warn 段（> 60% warnPct，< 100% hardLimit）
    await kv.put(PENDING_COUNT_KV_KEY, String(Math.floor(BACKPRESSURE_HARD_LIMIT * 0.7)));
    const ctx = makeContext(kv);
    const result = await enforceBackpressure(ctx as unknown as Parameters<typeof enforceBackpressure>[0]);

    expect(result).toBeNull();
    expect(ctx.setHeaders.get("X-Analyze-Backlog-Severity")).toBe("warn");
  });

  it("forces one matching canary request into the 503 overload path", async () => {
    const kv = new FakeKV();
    const env = { NONCE: kv } as unknown as Env;
    await kv.put(PENDING_COUNT_KV_KEY, "0");
    await armBackpressureCanary(env, {
      appId: "app_irc",
      bizType: "media_analysis",
      bizId: "canary-video-1",
      ttlSeconds: 60,
      armedBy: "test",
    });

    const first = makeContext(kv);
    const forced = await enforceBackpressure(
      first as unknown as Parameters<typeof enforceBackpressure>[0],
      undefined,
      { appId: "app_irc", bizType: "media_analysis", bizId: "canary-video-1" },
    );

    expect(forced).not.toBeNull();
    expect(forced!.status).toBe(503);
    expect(forced!.headers.get("X-Analyze-Backpressure-Canary")).toBe("1");
    expect(forced!.headers.get("X-Analyze-Backlog-Severity")).toBe("crit");
    const body = await forced!.json() as { error_code: string; canary: boolean };
    expect(body.error_code).toBe("backlog_overload");
    expect(body.canary).toBe(true);
    expect(await getBackpressureCanary(env, "app_irc")).toBeNull();

    const second = makeContext(kv);
    const normal = await enforceBackpressure(
      second as unknown as Parameters<typeof enforceBackpressure>[0],
      undefined,
      { appId: "app_irc", bizType: "media_analysis", bizId: "canary-video-1" },
    );
    expect(normal).toBeNull();
    expect(second.setHeaders.get("X-Analyze-Backlog-Severity")).toBe("ok");
  });

  it("does not force non-matching canary requests", async () => {
    const kv = new FakeKV();
    const env = { NONCE: kv } as unknown as Env;
    await kv.put(PENDING_COUNT_KV_KEY, "0");
    await armBackpressureCanary(env, {
      appId: "app_irc",
      bizType: "media_intro",
      bizId: "intro-canary",
      ttlSeconds: 60,
      armedBy: "test",
    });

    const ctx = makeContext(kv);
    const result = await enforceBackpressure(
      ctx as unknown as Parameters<typeof enforceBackpressure>[0],
      undefined,
      { appId: "app_irc", bizType: "media_analysis", bizId: "intro-canary" },
    );

    expect(result).toBeNull();
    expect(ctx.setHeaders.get("X-Analyze-Backlog-Severity")).toBe("ok");
    expect(await getBackpressureCanary(env, "app_irc")).toEqual(
      expect.objectContaining({ biz_type: "media_intro", biz_id: "intro-canary" }),
    );
  });
});
