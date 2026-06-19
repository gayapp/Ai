import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrokAdapter } from "../src/providers/grok.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";

function makeEnv(): Env {
  return { GROK_API_KEY: "xai-test-key", GROK_MODEL: "grok-4-fast-non-reasoning" } as unknown as Env;
}

const args = { systemPrompt: "rules", content: "hi", isImage: false, timeoutMs: 5000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("grok adapter · auth-failure classification", () => {
  it("maps 401 to PROVIDER_AUTH_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const adapter = createGrokAdapter(makeEnv());
    await expect(adapter.moderate(args)).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_FAILED });
  });

  it("maps xAI 400 'Incorrect API key' to PROVIDER_AUTH_FAILED (not PROVIDER_ERROR)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "invalid-argument", error: "Incorrect API key provided: xa***jU." }),
        { status: 400 },
      ),
    ));
    const adapter = createGrokAdapter(makeEnv());
    await expect(adapter.moderate(args)).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_FAILED });
  });

  it("keeps a generic 400 (no api-key mention) as PROVIDER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad request param" }), { status: 400 }),
    ));
    const adapter = createGrokAdapter(makeEnv());
    await expect(adapter.moderate(args)).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_ERROR });
  });

  it("maps 5xx to PROVIDER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    const adapter = createGrokAdapter(makeEnv());
    const err = await adapter.moderate(args).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.PROVIDER_ERROR);
  });
});
