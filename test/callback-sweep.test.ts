import { describe, expect, it } from "vitest";
import { sweepAnalyzeCallbackDeliveries } from "../src/callback/dispatcher.ts";

class FakeD1 {
  constructor(private readonly rows: Array<{ request_id: string; attempts: number | null }>) {}

  prepare(_sql: string): FakeStmt {
    return new FakeStmt(this.rows);
  }
}

class FakeStmt {
  constructor(private readonly rows: Array<{ request_id: string; attempts: number | null }>) {}

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

describe("analyze callback delivery sweep", () => {
  it("re-enqueues stale analyze callback deliveries with their attempt count", async () => {
    const queue = new MemQueue<object>();
    const env = {
      DB: new FakeD1([
        { request_id: "r1", attempts: 0 },
        { request_id: "r2", attempts: 2 },
        { request_id: "r3", attempts: null },
      ]),
      CALLBACK_QUEUE: queue,
    } as unknown as Env;

    const result = await sweepAnalyzeCallbackDeliveries(env);

    expect(result).toEqual({ scanned: 3, enqueued: 3, failed: 0 });
    expect(queue.sent).toEqual([
      { request_id: "r1", attempt: 0 },
      { request_id: "r2", attempt: 2 },
      { request_id: "r3", attempt: 0 },
    ]);
  });
});
