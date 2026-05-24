import { describe, expect, it, vi } from "vitest";
import { sweepModerationPending } from "../src/moderation/pending-sweep.ts";

interface SweepRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  mode: string;
  status: string;
  error_code: string | null;
  reason: string | null;
  created_at: number;
  completed_at: number | null;
}

class FakeD1 {
  readonly rows: SweepRow[];
  constructor(now: number) {
    this.rows = [
      row("old-pending", "pending", now - 7 * 60 * 1000),
      row("new-pending", "pending", now - 60 * 1000),
      row("old-pass", "pass", now - 10 * 60 * 1000),
    ];
  }
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(private readonly db: FakeD1, private readonly sql: string) {}
  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM moderation_requests")) return { results: [] };
    const cutoff = this.args[0] as number;
    const limit = this.args[1] as number;
    const results = this.db.rows
      .filter((row) => row.status === "pending" && row.created_at < cutoff)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit);
    return { results: results as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (!this.sql.includes("UPDATE moderation_requests")) return { meta: { changes: 0 } };
    const [completedAt, id] = this.args as [number, string];
    const row = this.db.rows.find((item) => item.id === id && item.status === "pending");
    if (!row) return { meta: { changes: 0 } };
    row.status = "error";
    row.error_code = "pending_timeout";
    row.reason = "Worker 未完成（sweep）";
    row.completed_at = completedAt;
    return { meta: { changes: 1 } };
  }
}

class FakeQueue {
  readonly jobs: unknown[] = [];
  async send(job: unknown): Promise<void> {
    this.jobs.push(job);
  }
}

class FakeKV {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

describe("moderation pending sweep", () => {
  it("marks stale pending rows, enqueues callbacks, and sends a Telegram alert", async () => {
    const now = Date.now();
    const db = new FakeD1(now);
    const queue = new FakeQueue();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sweepModerationPending({
      DB: db,
      CALLBACK_QUEUE: queue,
      DEDUP_CACHE: new FakeKV(),
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-id",
    } as unknown as Env, now);

    expect(result).toMatchObject({
      swept: 1,
      callbackEnqueued: 1,
      callbackFailed: 0,
      alertSent: true,
      ids: ["old-pending"],
    });
    expect(db.rows.find((row) => row.id === "old-pending")).toMatchObject({
      status: "error",
      error_code: "pending_timeout",
      reason: "Worker 未完成（sweep）",
      completed_at: now,
    });
    expect(db.rows.find((row) => row.id === "new-pending")?.status).toBe("pending");
    expect(queue.jobs).toEqual([{ request_id: "old-pending", attempt: 0 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function row(id: string, status: string, createdAt: number): SweepRow {
  return {
    id,
    app_id: "app_1",
    biz_type: "comment",
    biz_id: id,
    mode: "async",
    status,
    error_code: null,
    reason: null,
    created_at: createdAt,
    completed_at: null,
  };
}
