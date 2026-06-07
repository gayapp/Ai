import { afterEach, describe, expect, it, vi } from "vitest";
import { executeModeration, getErrorProvider } from "../src/moderation/pipeline.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

class FakeKV {
  readonly items = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.items.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: Array.from(this.items.keys()).map((name) => ({ name })) };
  }
}

class FakeD1 {
  prepare(_sql: string): FakeStmt {
    return new FakeStmt();
  }
}

class FakeStmt {
  bind(..._args: unknown[]): this {
    return this;
  }
  async first<T>(): Promise<T | null> {
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

function makeEnv(): Env {
  const prompts = new FakeKV();
  // pre-populate active prompts so loadActivePromptCached returns synchronously
  prompts.items.set(
    "comment:grok:active",
    JSON.stringify({ version: 1, content: "test prompt grok" }),
  );
  prompts.items.set(
    "comment:gemini:active",
    JSON.stringify({ version: 1, content: "test prompt gemini" }),
  );
  return {
    DB: new FakeD1(),
    NONCE: new FakeKV(),
    PROMPTS: prompts,
    DEDUP_CACHE: new FakeKV(),
    GROK_API_KEY: "grok-key",
    GEMINI_API_KEY: "gemini-key",
    GROK_MODEL: "grok-test",
    GEMINI_MODEL: "gemini-test",
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("executeModeration · M13 gemini safety-filter 400", () => {
  it.skip("returns synthesized status=review when fallback gemini 400 body contains 'safety' (gemini fallback removed 2026-06-04)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.x.ai")) {
          return new Response("grok blew up", { status: 502 });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "Request blocked by safety filter (PROHIBITED_CONTENT).",
              },
            }),
            { status: 400 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const env = makeEnv();
    const r = await executeModeration(env, {
      bizType: "comment",
      content: "some nsfw text the model dislikes",
      isImage: false,
      timeoutMs: 5000,
      strategy: "auto",
    });

    expect(r.status).toBe("review");
    expect(r.risk_level).toBe("medium");
    expect(r.categories).toEqual(["other"]);
    expect(r.reason).toBe("provider safety filter declined");
    expect(r.provider).toBe("gemini");
    expect(r.prompt_version).toBeNull();
    expect(r.model).toBeNull();
  });

  it("still throws PROVIDER_ERROR when fallback gemini 400 body has no safety keywords", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.x.ai")) {
          return new Response("grok blew up", { status: 502 });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({ error: { code: 400, message: "malformed request" } }),
            { status: 400 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const env = makeEnv();
    await expect(
      executeModeration(env, {
        bizType: "comment",
        content: "anything",
        isImage: false,
        timeoutMs: 5000,
        strategy: "auto",
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ERROR,
    });
  });

  it.skip("M16(c): fallback failure error carries fallback provider in details (gemini fallback removed 2026-06-04)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.x.ai")) {
          return new Response("grok blew up", { status: 502 });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          // 500 → 不走 synthesizeGeminiSafetyReview，直接抛 PROVIDER_ERROR
          return new Response("gemini also blew up", { status: 500 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const env = makeEnv();
    let caught: unknown;
    try {
      await executeModeration(env, {
        bizType: "comment",
        content: "x",
        isImage: false,
        timeoutMs: 5000,
        strategy: "auto",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AppError);
    // M16(c): tryProvider 注入 provider；最后抛出的应是 fallback (gemini) 的归因
    expect(getErrorProvider(caught)).toBe("gemini");
    // 同时 body 仍可访问（synthesizeGeminiSafetyReview 用 getErrorBody 兼容新形态）
    const details = (caught as AppError).details;
    expect(details).toMatchObject({ provider: "gemini" });
    expect(typeof (details as { body?: unknown }).body).toBe("string");
  });

  it("does not synthesize when fallback gemini returns 500 (only 400 is safety-filter territory)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.x.ai")) {
          return new Response("grok blew up", { status: 502 });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return new Response("safety incident upstream", { status: 500 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const env = makeEnv();
    await expect(
      executeModeration(env, {
        bizType: "comment",
        content: "anything",
        isImage: false,
        timeoutMs: 5000,
        strategy: "auto",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
