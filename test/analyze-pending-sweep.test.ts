import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepAnalyzePending } from "../src/analyze/pending-sweep.ts";

class FakeD1 {
  constructor(private readonly rows: Array<{
    id: string;
    app_id: string;
    biz_type: string;
    created_at: number;
  }>) {}

  prepare(_sql: string): FakeStmt {
    return new FakeStmt(this.rows);
  }
}

class FakeStmt {
  constructor(private readonly rows: Array<{
    id: string;
    app_id: string;
    biz_type: string;
    created_at: number;
  }>) {}

  bind(..._args: unknown[]): this {
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows as T[] };
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
  it("re-enqueues stale pending analyze requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createdAt = Date.now() - 10 * 60 * 1000;
    const queue = new MemQueue<object>();
    const env = {
      DB: new FakeD1([
        { id: "r1", app_id: "app_a", biz_type: "media_analysis", created_at: createdAt },
        { id: "r2", app_id: "app_a", biz_type: "media_intro", created_at: createdAt },
        { id: "r3", app_id: "app_a", biz_type: "unknown", created_at: createdAt },
      ]),
      ANALYZE_QUEUE: queue,
    } as unknown as Env;

    const result = await sweepAnalyzePending(env);

    expect(result).toEqual({ scanned: 3, enqueued: 2, failed: 1 });
    expect(queue.sent).toEqual([
      { request_id: "r1", app_id: "app_a", biz_type: "media_analysis", created_at_ms: createdAt },
      { request_id: "r2", app_id: "app_a", biz_type: "media_intro", created_at_ms: createdAt },
    ]);
  });
});
