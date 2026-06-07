import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepAnalyzePending } from "../src/analyze/pending-sweep.ts";

interface Row {
  id: string;
  app_id: string;
  biz_type: string;
  created_at: number;
  delivery_mode: string;
  provider_strategy?: string;
}

interface CompleteCall {
  id: string;
  provider: string | null;
  status: string;
  error_code: string;
}

class FakeD1 {
  readonly completeCalls: CompleteCall[] = [];
  constructor(
    private readonly giveUpRows: Row[],
    private readonly retryRows: Row[],
  ) {}

  prepare(sql: string): FakeStmt {
    // give-up query JOINs apps → SELECT 含 `r.biz_type`; retry query SELECT 含 `app_id, biz_type, created_at`;
    // completeAnalyze 走 UPDATE analyze_requests SET ...
    let rows: Row[] = [];
    if (sql.includes("LEFT JOIN apps")) rows = this.giveUpRows;
    else if (sql.includes("biz_type, created_at")) rows = this.retryRows;
    return new FakeStmt(rows, sql, this.completeCalls);
  }
}

class FakeStmt {
  private bindArgs: unknown[] = [];
  constructor(
    private readonly rows: Row[],
    private readonly sql: string,
    private readonly completeCalls: CompleteCall[],
  ) {}

  bind(...args: unknown[]): this {
    this.bindArgs = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows as unknown as T[] };
  }

  async run(): Promise<void> {
    // completeAnalyze 的 bind 顺序（见 db/analyze-requests.ts:81-94）：
    //   0:cached 1:status 2:result_json 3:provider 4:model 5:prompt_version
    //   6:input_tokens 7:output_tokens 8:latency_ms 9:error_code 10:now 11:id
    if (this.sql.includes("UPDATE analyze_requests")) {
      this.completeCalls.push({
        id: this.bindArgs[11] as string,
        provider: this.bindArgs[3] as string | null,
        status: this.bindArgs[1] as string,
        error_code: this.bindArgs[9] as string,
      });
    }
    return;
  }
}

class MemQueue<T> {
  readonly sent: T[] = [];
  async send(message: T): Promise<void> {
    this.sent.push(message);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyze pending sweep", () => {
  it("re-enqueues stale pending (within retry window)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createdAt = Date.now() - 10 * 60 * 1000;
    const analyzeQueue = new MemQueue<object>();
    const callbackQueue = new MemQueue<object>();
    const db = new FakeD1(
      [], // no give-up rows
      [
        { id: "r1", app_id: "app_a", biz_type: "media_analysis", created_at: createdAt, delivery_mode: "both" },
        { id: "r2", app_id: "app_a", biz_type: "media_intro", created_at: createdAt, delivery_mode: "both" },
        { id: "r3", app_id: "app_a", biz_type: "unknown", created_at: createdAt, delivery_mode: "both" },
      ],
    );
    const env = { DB: db, ANALYZE_QUEUE: analyzeQueue, CALLBACK_QUEUE: callbackQueue } as unknown as Env;

    const result = await sweepAnalyzePending(env);

    expect(result).toEqual({ scanned: 3, enqueued: 2, failed: 1, expired: 0 });
    expect(analyzeQueue.sent).toEqual([
      { request_id: "r1", app_id: "app_a", biz_type: "media_analysis", created_at_ms: createdAt },
      { request_id: "r2", app_id: "app_a", biz_type: "media_intro", created_at_ms: createdAt },
    ]);
    expect(callbackQueue.sent).toEqual([]);
  });

  it("gives up on over-aged pending: marks error + enqueues callback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = Date.now() - 3 * 60 * 60 * 1000; // 3h old → past give-up
    const analyzeQueue = new MemQueue<object>();
    const callbackQueue = new MemQueue<{ request_id: string; attempt: number }>();
    const db = new FakeD1(
      [
        // strategy=grok → media_analysis 应回填 provider="xai"
        { id: "g1", app_id: "app_a", biz_type: "media_analysis", created_at: old, delivery_mode: "both", provider_strategy: "grok" },
        { id: "g2", app_id: "app_a", biz_type: "media_analysis", created_at: old, delivery_mode: "pull", provider_strategy: "grok" },
      ],
      [], // nothing in retry window
    );
    const env = { DB: db, ANALYZE_QUEUE: analyzeQueue, CALLBACK_QUEUE: callbackQueue } as unknown as Env;

    const result = await sweepAnalyzePending(env);

    expect(result.expired).toBe(2);
    expect(result.enqueued).toBe(0);
    // only delivery_mode in (callback, both) gets a callback; pull does not
    expect(callbackQueue.sent).toEqual([{ request_id: "g1", attempt: 0 }]);
    // M25: sweep give-up 必须回填 intended_provider，不能再写 null
    expect(db.completeCalls).toEqual([
      { id: "g1", provider: "xai", status: "error", error_code: "pending_timeout" },
      { id: "g2", provider: "xai", status: "error", error_code: "pending_timeout" },
    ]);
  });

  it("M25: give-up falls back to default route when app row is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = Date.now() - 3 * 60 * 60 * 1000;
    const analyzeQueue = new MemQueue<object>();
    const callbackQueue = new MemQueue<{ request_id: string; attempt: number }>();
    const db = new FakeD1(
      [
        // app 已删 → provider_strategy=null → 走 'auto' → media_intro 默认 primary=xai
        { id: "g3", app_id: "app_deleted", biz_type: "media_intro", created_at: old, delivery_mode: "callback" },
        // biz_type 也无法识别 → 退回 provider=null（不污染但也无法归因）
        { id: "g4", app_id: "app_deleted", biz_type: "totally_unknown", created_at: old, delivery_mode: "pull" },
      ],
      [],
    );
    const env = { DB: db, ANALYZE_QUEUE: analyzeQueue, CALLBACK_QUEUE: callbackQueue } as unknown as Env;

    const result = await sweepAnalyzePending(env);

    expect(result.expired).toBe(2);
    expect(db.completeCalls).toEqual([
      { id: "g3", provider: "xai", status: "error", error_code: "pending_timeout" },
      { id: "g4", provider: null, status: "error", error_code: "pending_timeout" },
    ]);
  });
});
