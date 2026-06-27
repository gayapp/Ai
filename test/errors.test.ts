import { describe, it, expect } from "vitest";
import { AppError, ErrorCodes, publicDetails } from "../src/lib/errors.ts";

describe("publicDetails", () => {
  it("keeps only allowlisted keys, drops body and unknown keys", () => {
    expect(publicDetails({ provider: "grok", body: "API key ID: dad75919", foo: 1 })).toEqual({
      provider: "grok",
    });
    expect(publicDetails({ retry_after_seconds: 5 })).toEqual({ retry_after_seconds: 5 });
  });

  it("returns undefined for non-objects or when nothing is safe", () => {
    expect(publicDetails({ body: "secret" })).toBeUndefined();
    expect(publicDetails("a raw string body")).toBeUndefined();
    expect(publicDetails(undefined)).toBeUndefined();
    expect(publicDetails(null)).toBeUndefined();
  });
});

describe("AppError.toJSON redaction", () => {
  it("never leaks the provider error body to the client", () => {
    const e = new AppError(ErrorCodes.PROVIDER_AUTH_FAILED, 502, "grok auth failed", {
      provider: "grok",
      body: 'Failed check: SAFETY_CHECK_TYPE_CSAM, API key ID: dad75919',
    });
    const j = e.toJSON();
    expect(j).toEqual({
      error_code: "provider_auth_failed",
      message: "grok auth failed",
      details: { provider: "grok" },
    });
    expect(JSON.stringify(j)).not.toContain("dad75919");
    expect(JSON.stringify(j)).not.toContain("API key");
  });

  it("keeps retry_after_seconds (rate-limit detail is safe)", () => {
    const e = new AppError(ErrorCodes.RATE_LIMITED, 429, "rl", { retry_after_seconds: 1 });
    expect(e.toJSON().details).toEqual({ retry_after_seconds: 1 });
  });

  it("omits details entirely when the raw detail is an unstructured string body", () => {
    const e = new AppError(ErrorCodes.PROVIDER_ERROR, 502, "grok http 500", "raw upstream body");
    expect(e.toJSON()).toEqual({ error_code: "provider_error", message: "grok http 500" });
  });
});
