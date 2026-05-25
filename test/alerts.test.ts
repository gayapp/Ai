import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAndAlert, DEFAULT_THRESHOLDS } from "../src/alerts/telegram.ts";

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
      backlog?: {
        pending_older: number;
        oldest_pending_at: number | null;
        pull_unacked_older: number;
        oldest_pull_unacked_at: number | null;
        callback_undelivered_older: number;
        oldest_callback_undelivered_at: number | null;
      };
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
    if (this.sql.includes("FROM moderation_requests")) {
      return this.rows.moderation as T;
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
});

function makeEnv(rows: ConstructorParameters<typeof FakeD1>[0]): Env {
  return {
    DB: new FakeD1(rows),
    DEDUP_CACHE: new FakeKV(),
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
  } as unknown as Env;
}
