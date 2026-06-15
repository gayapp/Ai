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

describe("checkProviderHealth · /v1/models probe", () => {
  it("grok ok when the inference key lists models (http 200)", async () => {
    const { handler } = captureTelegram();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "grok-4-fast-non-reasoning" }] }), { status: 200 });
      }
      return handler(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await checkProviderHealth(makeEnv());

    expect(r.grok.ok).toBe(true);
    expect(r.fired).toHaveLength(0);
    // only the xAI probe — gemini is sunset, telegram only on failure
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits 🚨 crit unauthorized alert when /v1/models returns 401", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") return new Response("nope", { status: 401 });
      return handler(url, init);
    }));

    const r = await checkProviderHealth(makeEnv());

    expect(r.grok.ok).toBe(false);
    expect(r.grok.reason).toBe("unauthorized");
    expect(r.fired).toContain("grok:unauthorized");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("🚨");
    expect(sent[0]!.text).toContain("401");
  });

  it("treats xAI 400 'Incorrect API key' as unauthorized (not http_error)", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") {
        return new Response(
          JSON.stringify({ code: "invalid-argument", error: "Incorrect API key provided: xa***jU." }),
          { status: 400 },
        );
      }
      return handler(url, init);
    }));

    const r = await checkProviderHealth(makeEnv());

    expect(r.grok.ok).toBe(false);
    expect(r.grok.reason).toBe("unauthorized");
    expect(r.fired).toContain("grok:unauthorized");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("🚨");
  });

  it("ALERTS_DISABLED=true silences the alert even when grok is unhealthy", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") return new Response("nope", { status: 401 });
      return handler(url, init);
    }));

    const r = await checkProviderHealth(makeEnv({ ALERTS_DISABLED: "true" } as Partial<Env>));

    expect(r.grok.ok).toBe(false); // health still computed
    expect(r.grok.reason).toBe("unauthorized");
    expect(r.fired).toHaveLength(0); // but nothing fired
    expect(sent).toHaveLength(0);
  });

  it("uses separate dedup key per reason — http_error won't dedup an unauthorized alert", async () => {
    const { sent, handler } = captureTelegram();
    let xaiResponder: () => Response = () => new Response("bad", { status: 400 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") return xaiResponder();
      return handler(url, init);
    }));

    const env = makeEnv();
    await checkProviderHealth(env); // http_error (400)
    xaiResponder = () => new Response("nope", { status: 401 });
    await checkProviderHealth(env); // unauthorized (401)

    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain("400");
    expect(sent[1]!.text).toContain("401");
  });
});

describe("checkProviderHealth · M12 24h recurrence escalation", () => {
  it("second unauthorized alert within 24h is marked 复发", async () => {
    const { sent, handler } = captureTelegram();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.x.ai/v1/models") return new Response("nope", { status: 401 });
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
