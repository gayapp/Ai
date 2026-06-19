import { describe, expect, it, vi } from "vitest";
import { checkProviderHealth } from "../src/alerts/provider-health.ts";

class FakeKV {
  async get(_key: string): Promise<string | null> {
    return null;
  }

  async put(_key: string, _value: string, _opts?: unknown): Promise<void> {
  }
}

function makeEnv(): Env {
  return {
    DEDUP_CACHE: new FakeKV(),
    GROK_API_KEY: "grok-key",
    GEMINI_API_KEY: "gemini-key",
  } as unknown as Env;
}

describe("provider health Gemini sunset", () => {
  it("does not actively probe Gemini even when GEMINI_API_KEY is configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.x.ai/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "grok-4-fast-non-reasoning" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await checkProviderHealth(makeEnv());

    expect(report.grok.ok).toBe(true);
    expect(report.gemini).toEqual({ ok: true, reason: "skipped_gemini_sunset" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
