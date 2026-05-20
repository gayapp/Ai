import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { analyzeRouter } from "../src/routes/analyze.ts";
import { analyzeRecordsRouter } from "../src/routes/analyze-records.ts";
import { dispatchAnalyzeJob } from "../src/analyze/pipeline/dispatcher.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import { hmacSha256Hex, sha256Hex } from "../src/lib/hash.ts";
import type { AnalyzeJob, AnalyzeRow, DeliveryMode } from "../src/analyze/types.ts";

class MemKV {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
  async delete(k: string): Promise<void> { this.m.delete(k); }
}

class MemQueue<T> {
  readonly sent: T[] = [];
  async send(msg: T): Promise<void> { this.sent.push(msg); }
}

interface AppRow {
  id: string;
  name: string;
  secret: string;
  callback_url: string | null;
  biz_types: string;
  analyze_biz_types: string;
  delivery_mode: DeliveryMode;
  callback_max_concurrency: number;
  rate_limit_qps: number;
  disabled: number;
  provider_strategy: string;
  created_at: number;
}

class FakeD1 {
  readonly apps = new Map<string, AppRow>();
  readonly analyzeRows: AnalyzeRow[] = [];

  constructor() {
    this.addApp("app_a", "secret-a", "both");
    this.addApp("app_b", "secret-b", "both");
    this.addApp("app_callback", "secret-callback", "callback");
  }

  addApp(id: string, secret: string, delivery_mode: DeliveryMode): void {
    this.apps.set(id, {
      id,
      name: id,
      secret,
      callback_url: "https://consumer.example.com/analyze",
      biz_types: "[]",
      analyze_biz_types: JSON.stringify(["media_analysis", "media_intro"]),
      delivery_mode,
      callback_max_concurrency: 10,
      rate_limit_qps: 500,
      disabled: 0,
      provider_strategy: "auto",
      created_at: Date.now(),
    });
  }

  insertAnalyze(row: Partial<AnalyzeRow> & Pick<AnalyzeRow, "id" | "app_id" | "status">): AnalyzeRow {
    const full: AnalyzeRow = {
      biz_type: "media_analysis",
      biz_id: row.id,
      user_id: null,
      input_hash: "h",
      input_json: "{}",
      prompt_version: null,
      provider: "gemini",
      model: "stub",
      mode: "async",
      cached: 0,
      result_json: row.status === "ok" ? JSON.stringify({ ok: true, id: row.id }) : null,
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      error_code: row.status === "error" ? "provider_error" : null,
      delivery_mode: "both",
      callback_url: null,
      extra_json: null,
      delivered_at: null,
      acked_at: null,
      created_at: Date.now(),
      completed_at: Date.now(),
      ...row,
    };
    this.analyzeRows.push(full);
    return full;
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
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM apps WHERE id = ?")) {
      return (this.db.apps.get(this.args[0] as string) ?? null) as T | null;
    }
    if (this.sql.includes("FROM analyze_requests WHERE id = ?")) {
      return (this.db.analyzeRows.find((r) => r.id === this.args[0]) ?? null) as T | null;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM analyze_requests") && this.sql.includes("ORDER BY id ASC")) {
      const appId = this.args[0] as string;
      const status = this.args[1] as string;
      let index = 2;
      const hasBiz = this.sql.includes("biz_type = ?");
      const biz = hasBiz ? this.args[index++] as string : undefined;
      const hasSince = this.sql.includes("id > ?");
      const since = hasSince ? this.args[index++] as string : undefined;
      const unacked = this.sql.includes("acked_at IS NULL");
      const limitPlusOne = this.args[this.args.length - 1] as number;

      const rows = this.db.analyzeRows
        .filter((r) => r.app_id === appId)
        .filter((r) => r.status === status)
        .filter((r) => r.delivery_mode === "pull" || r.delivery_mode === "both")
        .filter((r) => !biz || r.biz_type === biz)
        .filter((r) => !since || r.id > since)
        .filter((r) => !unacked || r.acked_at === null)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limitPlusOne);
      return { results: rows as T[] };
    }
    return { results: [] };
  }
  async run(): Promise<unknown> {
    if (this.sql.includes("INSERT INTO analyze_requests")) {
      this.db.insertAnalyze({
        id: this.args[0] as string,
        app_id: this.args[1] as string,
        biz_type: this.args[2] as string,
        biz_id: this.args[3] as string,
        user_id: this.args[4] as string | null,
        input_hash: this.args[5] as string,
        input_json: this.args[6] as string,
        mode: this.args[7] as string,
        status: "pending",
        delivery_mode: this.args[8] as string,
        callback_url: this.args[9] as string | null,
        extra_json: this.args[10] as string | null,
        created_at: this.args[11] as number,
        completed_at: null,
        provider: null,
        model: null,
        result_json: null,
        input_tokens: null,
        output_tokens: null,
        latency_ms: null,
        error_code: null,
      });
    } else if (this.sql.includes("UPDATE analyze_requests SET") && this.sql.includes("completed_at")) {
      const row = this.db.analyzeRows.find((r) => r.id === this.args[11]);
      if (row) {
        row.cached = this.args[0] as number;
        row.status = this.args[1] as string;
        row.result_json = this.args[2] as string | null;
        row.provider = this.args[3] as string | null;
        row.model = this.args[4] as string | null;
        row.prompt_version = this.args[5] as number | null;
        row.input_tokens = this.args[6] as number;
        row.output_tokens = this.args[7] as number;
        row.latency_ms = this.args[8] as number;
        row.error_code = this.args[9] as string | null;
        row.completed_at = this.args[10] as number;
      }
    } else if (this.sql.includes("UPDATE analyze_requests SET acked_at = ?")) {
      const row = this.db.analyzeRows.find((r) => r.id === this.args[1]);
      if (row && row.acked_at === null) row.acked_at = this.args[0] as number;
    }
    return {};
  }
}

describe("analyze pull API", () => {
  let db: FakeD1;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let nonceCounter = 0;

  beforeEach(() => {
    db = new FakeD1();
    env = {
      DB: db,
      NONCE: new MemKV(),
      APPS: new MemKV(),
      ANALYZE_QUEUE: new MemQueue<AnalyzeJob>(),
      CALLBACK_QUEUE: new MemQueue<object>(),
      DEFAULT_RATE_LIMIT_QPS: "50",
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>({ strict: false });
    app.route("/", analyzeRouter);
    app.route("/", analyzeRecordsRouter);
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.status as 400);
      }
      return c.json({ error_code: ErrorCodes.INTERNAL, message: "internal error" }, 500);
    });
  });

  it("single query returns completed POST result for same app", async () => {
    const body = JSON.stringify({
      biz_type: "media_analysis",
      biz_id: "video-posted",
      input: { image_urls: ["https://cdn.example.com/1.jpg"] },
    });
    const post = await app.fetch(new Request("http://local/v1/analyze", {
      method: "POST",
      headers: await signedHeaders("app_a", "secret-a", body, nonceCounter++),
      body,
    }), env);
    expect(post.status).toBe(202);
    const accepted = await post.json() as { request_id: string };
    const queued = (env.ANALYZE_QUEUE as unknown as MemQueue<AnalyzeJob>).sent[0]!;
    await dispatchAnalyzeJob(env, queued);

    const get = await app.fetch(new Request(`http://local/v1/analyze/${accepted.request_id}`, {
      headers: await signedHeaders("app_a", "secret-a", "", nonceCounter++),
    }), env);
    expect(get.status).toBe(200);
    const payload = await get.json() as { request_id: string; status: string; error_code: string };
    expect(payload).toMatchObject({
      request_id: accepted.request_id,
      status: "error",
      error_code: "not_implemented",
    });
  });

  it("single query is isolated across apps", async () => {
    const row = db.insertAnalyze({ id: "r-cross", app_id: "app_a", status: "ok" });
    const res = await app.fetch(new Request(`http://local/v1/analyze/${row.id}`, {
      headers: await signedHeaders("app_b", "secret-b", "", nonceCounter++),
    }), env);
    expect(res.status).toBe(404);
  });

  it("cursor pagination returns 2/2/1 then no next cursor for 5 rows", async () => {
    for (let i = 1; i <= 5; i++) {
      db.insertAnalyze({ id: `r00${i}`, app_id: "app_a", status: "ok" });
    }
    const page1 = await pull("app_a", "secret-a", "status=ok&limit=2");
    expect(page1.items.map((r) => r.request_id)).toEqual(["r001", "r002"]);
    expect(page1.next_since_id).toBe("r002");

    const page2 = await pull("app_a", "secret-a", `status=ok&limit=2&since_id=${page1.next_since_id}`);
    expect(page2.items.map((r) => r.request_id)).toEqual(["r003", "r004"]);
    expect(page2.next_since_id).toBe("r004");

    const page3 = await pull("app_a", "secret-a", `status=ok&limit=2&since_id=${page2.next_since_id}`);
    expect(page3.items.map((r) => r.request_id)).toEqual(["r005"]);
    expect(page3.next_since_id).toBeNull();
  });

  it("include=unacked filters acked rows", async () => {
    db.insertAnalyze({ id: "r101", app_id: "app_a", status: "ok" });
    db.insertAnalyze({ id: "r102", app_id: "app_a", status: "ok" });
    db.insertAnalyze({ id: "r103", app_id: "app_a", status: "ok" });
    const ackRes = await ack("app_a", "secret-a", "r102");
    expect(ackRes.status).toBe(200);

    const page = await pull("app_a", "secret-a", "status=ok&include=unacked");
    expect(page.items.map((r) => r.request_id)).toEqual(["r101", "r103"]);
  });

  it("include=all returns acked and unacked rows", async () => {
    db.insertAnalyze({ id: "r201", app_id: "app_a", status: "ok" });
    db.insertAnalyze({ id: "r202", app_id: "app_a", status: "ok" });
    db.insertAnalyze({ id: "r203", app_id: "app_a", status: "ok" });
    await ack("app_a", "secret-a", "r202");

    const page = await pull("app_a", "secret-a", "status=ok&include=all");
    expect(page.items.map((r) => r.request_id)).toEqual(["r201", "r202", "r203"]);
  });

  it("ack is idempotent and does not refresh acked_at", async () => {
    db.insertAnalyze({ id: "r301", app_id: "app_a", status: "ok" });
    const first = await ack("app_a", "secret-a", "r301");
    const firstBody = await first.json() as { acked_at: string };
    const second = await ack("app_a", "secret-a", "r301");
    const secondBody = await second.json() as { acked_at: string };
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.acked_at).toBe(firstBody.acked_at);
  });

  it("ack rejects callback-only requests", async () => {
    db.insertAnalyze({
      id: "r401",
      app_id: "app_callback",
      status: "ok",
      delivery_mode: "callback",
    });
    const res = await ack("app_callback", "secret-callback", "r401");
    expect(res.status).toBe(409);
  });

  it("large cursor pull returns 200 rows in four 50-row pages without duplicates", async () => {
    for (let i = 1; i <= 200; i++) {
      db.insertAnalyze({ id: `r${String(i).padStart(3, "0")}`, app_id: "app_a", status: "ok" });
    }
    const seen = new Set<string>();
    let since: string | null = null;
    for (let round = 0; round < 4; round++) {
      const query = `status=ok&limit=50${since ? `&since_id=${since}` : ""}`;
      const page = await pull("app_a", "secret-a", query);
      expect(page.items).toHaveLength(50);
      for (const item of page.items) {
        expect(seen.has(item.request_id)).toBe(false);
        seen.add(item.request_id);
      }
      since = page.next_since_id ?? page.items[page.items.length - 1]!.request_id;
    }
    expect(seen.size).toBe(200);
  });

  async function pull(appId: string, secret: string, query: string): Promise<{
    items: Array<{ request_id: string }>;
    next_since_id: string | null;
  }> {
    const res = await app.fetch(new Request(`http://local/v1/analyze?${query}`, {
      headers: await signedHeaders(appId, secret, "", nonceCounter++),
    }), env);
    expect(res.status).toBe(200);
    return await res.json() as { items: Array<{ request_id: string }>; next_since_id: string | null };
  }

  async function ack(appId: string, secret: string, id: string): Promise<Response> {
    return await app.fetch(new Request(`http://local/v1/analyze/${id}/ack`, {
      method: "POST",
      headers: await signedHeaders(appId, secret, "", nonceCounter++),
    }), env);
  }
});

async function signedHeaders(
  appId: string,
  secret: string,
  body: string,
  nonceSeed: number,
): Promise<Headers> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = `000000000000${nonceSeed.toString(16).padStart(4, "0")}`;
  const bodyHash = await sha256Hex(body);
  const sig = await hmacSha256Hex(secret, `${ts}\n${nonce}\n${bodyHash}`);
  return new Headers({
    "content-type": "application/json",
    "x-app-id": appId,
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-signature": sig,
  });
}
