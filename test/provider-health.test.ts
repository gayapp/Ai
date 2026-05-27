import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertProviderAuthFailed, checkProviderHealth } from "../src/alerts/provider-health.ts";

class FakeKV {
  readonly items = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.items.set(key, value);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DEDUP_CACHE: new FakeKV(),
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
    GROK_API_KEY: "grok-key",
    GEMINI_API_KEY: "gemini-key",
    ...overrides,
  } as unknown as Env;
}

interface SentTg {
  text: string;
  chat_id: string;
}

function captureTelegram(): {
  sent: SentTg[];
  /** mock fetch handler — caller swaps in extra responders before this one */
  handler: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const sent: SentTg[] = [];
  return {
    sent,
    handler: async (url: string, init?: RequestInit) => {
      if (url.includes("api.telegram.org")) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkProviderHealth · M11 team_blocked", () => {
  it("emits 🚨🚨 crit alert with console.x.ai when xAI returns team_blocked=true", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/api-key") {
        return new Response(
          JSON.stringify({ team_blocked: true, api_key_blocked: false, api_key_disabled: false }),
          { status: 200 },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        // gemini health probe: return a valid moderation JSON
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: "pass", risk_level: "safe", categories: [], reason: "ok" }) }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        );
      }
      return handler(url, init);
    }));

    const env = makeEnv();
    const r = await checkProviderHealth(env);

    expect(r.grok.ok).toBe(false);
    expect(r.grok.reason).toBe("team_blocked");
    expect(r.fired).toContain("grok:team_blocked");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("🚨🚨");
    expect(sent[0]!.text).toContain("console.x.ai");
    expect(sent[0]!.text).toContain("组织级屏蔽");
  });

  it("uses separate dedup key per reason — team_blocked alert won't dedup an unauthorized alert", async () => {
    const { sent, handler } = captureTelegram();
    let xaiResponder: () => Response = () =>
      new Response(JSON.stringify({ team_blocked: true, api_key_blocked: false, api_key_disabled: false }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/api-key") return xaiResponder();
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: "pass", risk_level: "safe", categories: [], reason: "ok" }) }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        );
      }
      return handler(url, init);
    }));

    const env = makeEnv();
    await checkProviderHealth(env);
    xaiResponder = () => new Response("nope", { status: 401 });
    await checkProviderHealth(env);

    expect(sent).toHaveLength(2);
    // Telegram Markdown escape turns _ into \_, so compare against escaped form
    expect(sent[0]!.text).toContain("team\\_blocked");
    expect(sent[1]!.text).toContain("401");
  });
});

describe("checkProviderHealth · M12 24h recurrence escalation", () => {
  it("second team_blocked alert within 24h is marked 复发", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/api-key") {
        return new Response(
          JSON.stringify({ team_blocked: true, api_key_blocked: false, api_key_disabled: false }),
          { status: 200 },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: "pass", risk_level: "safe", categories: [], reason: "ok" }) }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        );
      }
      return handler(url, init);
    }));

    const env = makeEnv();
    await checkProviderHealth(env);
    // Simulate that the first dedup window has expired by clearing the alert-dedup
    // KV entry directly (dedupTtlSeconds=600 in code, but we want to test recurrence,
    // not dedup). 复发 计数 (recur-count:*) MUST survive.
    const kv = env.DEDUP_CACHE as unknown as FakeKV;
    for (const key of Array.from(kv.items.keys())) {
      if (key.startsWith("alert-dedup:")) kv.items.delete(key);
    }
    await checkProviderHealth(env);

    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).not.toContain("复发");
    expect(sent[1]!.text).toContain("复发");
    expect(sent[1]!.text).toContain("24h 内 2 次");
  });
});

describe("alertProviderAuthFailed · M12 recurrence", () => {
  it("marks second auth failure within 24h as 复发", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));

    const env = makeEnv();
    await alertProviderAuthFailed(env, "grok", "first", "body1");
    // clear short-window alert-dedup so the 2nd alert fires
    const kv = env.DEDUP_CACHE as unknown as FakeKV;
    for (const key of Array.from(kv.items.keys())) {
      if (key.startsWith("alert-dedup:")) kv.items.delete(key);
    }
    await alertProviderAuthFailed(env, "grok", "second", "body2");

    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).not.toContain("复发");
    expect(sent[1]!.text).toContain("复发");
    expect(sent[1]!.text).toContain("24h 内 2 次");
  });
});
