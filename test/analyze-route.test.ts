import { describe, expect, it } from "vitest";
import { analyzeRouter } from "../src/routes/analyze.ts";
import { hmacSha256Hex, sha256Hex } from "../src/lib/hash.ts";
import type { AnalyzeRow } from "../src/analyze/types.ts";

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

class FakeD1 {
  readonly analyzeRows: AnalyzeRow[] = [];
  readonly app = {
    id: "app_analyze",
    name: "Analyze App",
    secret: "test-secret",
    callback_url: "https://consumer.example.com/analyze",
    biz_types: "[]",
    analyze_biz_types: JSON.stringify(["media_analysis", "media_intro"]),
    delivery_mode: "both",
    callback_max_concurrency: 10,
    rate_limit_qps: 50,
    disabled: 0,
    provider_strategy: "auto",
    created_at: Date.now(),
  };

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
      return this.args[0] === this.db.app.id ? this.db.app as T : null;
    }
    return null;
  }
  async run(): Promise<unknown> {
    if (this.sql.includes("INSERT INTO analyze_requests")) {
      this.db.analyzeRows.push({
        id: this.args[0] as string,
        app_id: this.args[1] as string,
        biz_type: this.args[2] as string,
        biz_id: this.args[3] as string,
        user_id: this.args[4] as string | null,
        input_hash: this.args[5] as string,
        input_json: this.args[6] as string,
        mode: this.args[7] as string,
        cached: 0,
        status: "pending",
        delivery_mode: this.args[8] as string,
        callback_url: this.args[9] as string | null,
        extra_json: this.args[10] as string | null,
        prompt_version: null,
        provider: null,
        model: null,
        result_json: null,
        input_tokens: null,
        output_tokens: null,
        latency_ms: null,
        error_code: null,
        delivered_at: null,
        acked_at: null,
        created_at: this.args[11] as number,
        completed_at: null,
      });
    }
    return {};
  }
}

describe("POST /v1/analyze", () => {
  it("authenticates, records pending input_json, and enqueues analyze job", async () => {
    const body = JSON.stringify({
      biz_type: "media_analysis",
      biz_id: "video-1",
      input: {
        title: "Example",
        image_urls: ["https://cdn.example.com/f1.jpg"],
      },
      extra: { trace_id: "t1" },
    });
    const db = new FakeD1();
    const analyzeQueue = new MemQueue<object>();
    const env = {
      DB: db,
      NONCE: new MemKV(),
      APPS: new MemKV(),
      ANALYZE_QUEUE: analyzeQueue,
      DEFAULT_RATE_LIMIT_QPS: "50",
    } as unknown as Env;
    const headers = await signedHeaders(db.app.id, db.app.secret, body);

    const res = await analyzeRouter.fetch(
      new Request("http://local/v1/analyze", {
        method: "POST",
        headers,
        body,
      }),
      env,
    );

    expect(res.status).toBe(202);
    const payload = await res.json() as { request_id: string };
    expect(payload.request_id).toMatch(/^[0-9a-z]/i);
    expect(db.analyzeRows).toHaveLength(1);
    expect(db.analyzeRows[0]!.id).toBe(payload.request_id);
    expect(db.analyzeRows[0]!.status).toBe("pending");
    expect(JSON.parse(db.analyzeRows[0]!.input_json)).toEqual({
      image_urls: ["https://cdn.example.com/f1.jpg"],
      title: "Example",
    });
    expect(db.analyzeRows[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.analyzeRows[0]!.delivery_mode).toBe("both");
    expect(analyzeQueue.sent).toEqual([
      expect.objectContaining({
        request_id: payload.request_id,
        app_id: "app_analyze",
        biz_type: "media_analysis",
      }),
    ]);
  });
});

async function signedHeaders(
  appId: string,
  secret: string,
  body: string,
): Promise<Headers> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = "0123456789abcdef";
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
