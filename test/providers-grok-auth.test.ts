import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrokAdapter, classifyXaiSafetyBlock } from "../src/providers/grok.ts";
import { AppError, ErrorCodes } from "../src/lib/errors.ts";
import { ModelOutput } from "../src/moderation/schema.ts";

const CSAM_403_BODY = JSON.stringify({
  code: "permission-denied",
  error:
    "Content violates usage guidelines. Team: t, API key ID: k, Model: grok-4.3, Failed check: SAFETY_CHECK_TYPE_CSAM",
});

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

  // xAI 输入安全拦截(CSAM)是「内容违规」，必须 fail-closed 判 reject，不能误判成鉴权失败。
  it("maps xAI 403 SAFETY_CHECK_TYPE_CSAM to a reject verdict (NOT auth-failed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(CSAM_403_BODY, { status: 403 })));
    const adapter = createGrokAdapter(makeEnv());
    const r = await adapter.moderate(args); // resolves, does not throw
    const parsed = ModelOutput.parse(JSON.parse(r.rawText));
    expect(parsed.status).toBe("reject");
    expect(parsed.risk_level).toBe("high");
    expect(parsed.categories).toContain("porn");
    expect(parsed.reason).toMatch(/CSAM/);
  });

  it("still treats a 403 WITHOUT safety markers as PROVIDER_AUTH_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "forbidden: key revoked" }), { status: 403 }),
    ));
    const adapter = createGrokAdapter(makeEnv());
    await expect(adapter.moderate(args)).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_FAILED });
  });
});

describe("classifyXaiSafetyBlock", () => {
  it("classifies CSAM block", () => {
    expect(classifyXaiSafetyBlock(403, CSAM_403_BODY)).toMatchObject({ category: "porn", labelCategory: "csam" });
  });
  it("classifies unknown safety type as other/no-label", () => {
    const b = JSON.stringify({ code: "permission-denied", error: "Failed check: SAFETY_CHECK_TYPE_SOMETHING" });
    expect(classifyXaiSafetyBlock(403, b)).toMatchObject({ category: "other", labelCategory: null });
  });
  it("returns null for auth-ish 403 (no safety markers)", () => {
    expect(classifyXaiSafetyBlock(403, "forbidden")).toBeNull();
  });
  it("returns null for non-403", () => {
    expect(classifyXaiSafetyBlock(401, CSAM_403_BODY)).toBeNull();
    expect(classifyXaiSafetyBlock(400, "Incorrect API key")).toBeNull();
  });
});
