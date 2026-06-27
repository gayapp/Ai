import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAndAlert, checkD1SizeAndAlert, DEFAULT_THRESHOLDS, D1_SIZE_SNAPSHOT_KV_KEY } from "../src/alerts/telegram.ts";

class FakeKV {
  readonly items = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }
}

class FakeD1 {
  constructor(
    private readonly rows: {
      moderation: { total: number; errors: number; avg_lat: number; max_lat: number };
      analyze: { total: number; errors: number; pending: number; avg_lat: number; max_lat: number };
      analyzeErrorCodes?: Array<{ error_code: string | null; n: number }>;
      unexpectedProviders?: Array<{ app_id: string; app_name: string | null; n: number; latest_at: number | null }>;
      backlog?: {
        pending_older: number;
        oldest_pending_at: number | null;
        pull_unacked_older: number;
        oldest_pull_unacked_at: number | null;
        callback_undelivered_older: number;
        oldest_callback_undelivered_at: number | null;
      };
      analyzeCache?: { total: number; cached_n: number };
      moderationZeroTraffic?: { total: number };
      analyzeSawTooth?: { slow_n: number };
    },
  ) {}

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.rows, sql);
  }
}

class FakeStmt {
  constructor(
    private readonly rows: ConstructorParameters<typeof FakeD1>[0],
    private readonly sql: string,
  ) {}

  bind(..._args: unknown[]): this {
    return this;
  }

  async first<T>(): Promise<T | null> {
    // M7：moderation 6h 零流量 probe，SELECT 形如 `SELECT COUNT(*) AS total FROM moderation_requests`
    //    比通用 moderation SELECT 多一个 WHERE created_at >= ? 的简单形态；按 SQL 长度区分太脆，
    //    直接走"只 SELECT total" 这个特征：sql 不含 'errors' 但含 'moderation_requests' 且含 'AS total'
    if (
      this.sql.includes("FROM moderation_requests") &&
      this.sql.includes("AS total") &&
      !this.sql.includes("errors")
    ) {
      // 默认 total: 1（非零）确保不会无意触发 M7 zero-traffic 告警
      return (this.rows.moderationZeroTraffic ?? { total: 1 }) as T;
    }
    if (this.sql.includes("FROM moderation_requests")) {
      return this.rows.moderation as T;
    }
    // M26 cache-hit probe：SELECT 含 cached_n，要在通用 analyze 分支之前匹配
    if (this.sql.includes("cached_n")) {
      return (this.rows.analyzeCache ?? { total: 0, cached_n: 0 }) as T;
    }
    // M14 saw-tooth probe：SELECT 含 slow_n
    if (this.sql.includes("slow_n")) {
      return (this.rows.analyzeSawTooth ?? { slow_n: 0 }) as T;
    }
    if (this.sql.includes("FROM analyze_requests") && this.sql.includes("COUNT(*) AS total")) {
      return this.rows.analyze as T;
    }
    if (this.sql.includes("pending_older")) {
      return (this.rows.backlog ?? {
        pending_older: 0,
        oldest_pending_at: null,
        pull_unacked_older: 0,
        oldest_pull_unacked_at: null,
        callback_undelivered_older: 0,
        oldest_callback_undelivered_at: null,
      }) as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("provider_strategy = 'grok'")) {
      return { results: (this.rows.unexpectedProviders ?? []) as T[] };
    }
    if (this.sql.includes("GROUP BY error_code")) {
      return { results: (this.rows.analyzeErrorCodes ?? []) as T[] };
    }
    return { results: [] };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("alert checks", () => {
  it("alerts on analyze error rate even when moderate samples are low", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 40, errors: 4, pending: 0, avg_lat: 1000, max_lat: 2000 },
      analyzeErrorCodes: [{ error_code: "provider_error", n: 4 }],
    });
    const result = await checkAndAlert(env);

    expect(result.checks.some((line) => line.includes("moderate samples=0"))).toBe(true);
    expect(result.fired).toContain("analyze-error-rate");
    expect(result.fired).not.toContain("error-rate");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("provider\\\\_error=4");
  });

  it("alerts on analyze backlog age buckets", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const now = Date.now();
    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      backlog: {
        pending_older: 1,
        oldest_pending_at: now - 10 * 60 * 1000,
        pull_unacked_older: DEFAULT_THRESHOLDS.analyzePullUnackedMinCount,
        oldest_pull_unacked_at: now - 3 * 60 * 60 * 1000,
        callback_undelivered_older: 1,
        oldest_callback_undelivered_at: now - 40 * 60 * 1000,
      },
    });
    const result = await checkAndAlert(env);

    expect(result.fired).toEqual(expect.arrayContaining([
      "analyze-pending-timeout",
      "analyze-pull-unacked",
      "analyze-callback-undelivered",
    ]));
    expect(sent).toHaveLength(3);
  });

  it("skips moderation error-rate when absolute errors below minErrorCount", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 9, errors: 1, avg_lat: 200, max_lat: 1000 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
    });
    const result = await checkAndAlert(env);

    expect(result.fired).not.toContain("error-rate");
    expect(sent).toHaveLength(0);
  });

  it("M26: alerts when analyze cache hit rate drops below threshold", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      analyzeCache: { total: 500, cached_n: 50 }, // 10% hit < 30% 阈值
    });
    const result = await checkAndAlert(env);

    expect(result.fired).toContain("analyze-cache-hit-low");
    expect(result.checks.some((line) => line.includes("cache_hit_24h=10.0%"))).toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { text: string }).text).toContain("cache hit");
  });

  it("M26: does not alert when analyze cache hit sample is below minSample", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      analyzeCache: { total: 50, cached_n: 0 }, // 0% hit 但样本数 < 100 minSample
    });
    const result = await checkAndAlert(env);

    expect(result.fired).not.toContain("analyze-cache-hit-low");
    expect(result.checks.some((line) => line.includes("cache_hit samples=50 < min=100"))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("M26: healthy cache hit does not fire", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      analyzeCache: { total: 2415, cached_n: 2189 }, // 90.7% hit（5-31 实际数据）
    });
    const result = await checkAndAlert(env);

    expect(result.fired).not.toContain("analyze-cache-hit-low");
    expect(result.checks.some((line) => line.includes("cache_hit_24h=90.6%"))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("M7: alerts when moderation has zero traffic in 6h window", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      moderationZeroTraffic: { total: 0 },
    });
    const result = await checkAndAlert(env);

    expect(result.fired).toContain("moderation-zero-traffic");
    expect(result.checks.some((line) => line.includes("moderation_zero_traffic_6h=0"))).toBe(true);
    expect((sent[0] as { text: string }).text).toContain("零流量");
  });

  it("M7: does not alert when moderation has any traffic", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      moderationZeroTraffic: { total: 12 },
    });
    const result = await checkAndAlert(env);

    expect(result.fired).not.toContain("moderation-zero-traffic");
    expect(result.checks.some((line) => line.includes("moderation_zero_traffic_6h=12"))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("M14: alerts on chronic saw-tooth (slow_n above threshold)", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      analyzeSawTooth: { slow_n: 80 }, // ≥ 50 阈值
    });
    const result = await checkAndAlert(env);

    expect(result.fired).toContain("analyze-sawtooth-chronic");
    expect(result.checks.some((line) => line.includes("sawtooth_3h_slow5m=80"))).toBe(true);
    expect((sent[0] as { text: string }).text).toContain("partial degraded");
  });

  it("M14: does not alert when saw-tooth count below threshold", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 0, errors: 0, pending: 0, avg_lat: 0, max_lat: 0 },
      analyzeSawTooth: { slow_n: 10 },
    });
    const result = await checkAndAlert(env);

    expect(result.fired).not.toContain("analyze-sawtooth-chronic");
    expect(result.checks.some((line) => line.includes("sawtooth_3h_slow5m=10"))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("alerts when grok strategy analyze traffic reaches Gemini", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));

    const env = makeEnv({
      moderation: { total: 0, errors: 0, avg_lat: 0, max_lat: 0 },
      analyze: { total: 40, errors: 0, pending: 0, avg_lat: 1000, max_lat: 2000 },
      unexpectedProviders: [{
        app_id: "app_irc",
        app_name: "IRC",
        n: 2,
        latest_at: Date.now(),
      }],
    });
    const result = await checkAndAlert(env);

    expect(result.checks).toContain("analyze grok_strategy_gemini=2");
    expect(result.fired).toContain("analyze-provider-mismatch");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { text: string }).text).toContain("provider\\_strategy=grok");
  });
});

function makeEnv(rows: ConstructorParameters<typeof FakeD1>[0]): Env {
  return {
    DB: new FakeD1(rows),
    DEDUP_CACHE: new FakeKV(),
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
  } as unknown as Env;
}

// =============================================================
// M28: D1 size delta monitoring
// =============================================================

class FakeD1SizeStmt {
  constructor(private readonly pageCount: number, private readonly pageSize: number, private readonly sql: string) {}
  async first<T>(): Promise<T> {
    if (this.sql.includes("page_count")) return { page_count: this.pageCount } as T;
    if (this.sql.includes("page_size")) return { page_size: this.pageSize } as T;
    return {} as T;
  }
}
class FakeD1Size {
  constructor(private readonly pageCount: number, private readonly pageSize: number) {}
  prepare(sql: string): FakeD1SizeStmt { return new FakeD1SizeStmt(this.pageCount, this.pageSize, sql); }
}

function makeD1SizeEnv(opts: { pages: number; pageSize: number; kv: FakeKV }): Env {
  return {
    DB: new FakeD1Size(opts.pages, opts.pageSize),
    NONCE: opts.kv,
    DEDUP_CACHE: new FakeKV(),
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
  } as unknown as Env;
}

describe("M28 · D1 size delta monitoring", () => {
  it("first run records snapshot without firing", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const kv = new FakeKV();
    const env = makeD1SizeEnv({ pages: 100000, pageSize: 4096, kv }); // ~400MB
    const result = await checkD1SizeAndAlert(env);

    expect(result.fired).not.toContain("d1-size-delta");
    expect(sent).toHaveLength(0);
    expect(kv.items.get(D1_SIZE_SNAPSHOT_KV_KEY)).toBeTruthy();
    expect(result.checks.some((c) => c.includes("first snapshot"))).toBe(true);
  });

  it("fires warn when delta exceeds warn threshold", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const kv = new FakeKV();
    // Prior snapshot: 300MB, 25h ago
    await kv.put(D1_SIZE_SNAPSHOT_KV_KEY, JSON.stringify({
      size_bytes: 300 * 1024 * 1024,
      ts_ms: Date.now() - 25 * 3600_000,
    }));
    // Current: 250MB more (550MB total) — beyond warn (200MB) but under crit (500MB)
    const env = makeD1SizeEnv({ pages: 140800, pageSize: 4096, kv });
    const result = await checkD1SizeAndAlert(env);

    expect(result.fired).toContain("d1-size-delta");
    expect((sent[0] as { text: string }).text).toContain("D1 size 涨速");
    expect((sent[0] as { text: string }).text).toContain("ai-guard");
  });

  it("does not fire when delta below warn threshold", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const kv = new FakeKV();
    // Prior 300MB; current 360MB → +60MB delta < 200MB warn
    await kv.put(D1_SIZE_SNAPSHOT_KV_KEY, JSON.stringify({
      size_bytes: 300 * 1024 * 1024,
      ts_ms: Date.now() - 24 * 3600_000,
    }));
    const env = makeD1SizeEnv({ pages: 92160, pageSize: 4096, kv });
    const result = await checkD1SizeAndAlert(env);

    expect(result.fired).not.toContain("d1-size-delta");
    expect(sent).toHaveLength(0);
    expect(result.checks.some((c) => c.includes("delta_") && c.includes("60MB"))).toBe(true);
  });
});
