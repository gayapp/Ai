import { describe, it, expect } from "vitest";
import { verifyAdmin } from "../src/auth/hmac.ts";
import { AppError } from "../src/lib/errors.ts";

const TOKEN = "s3cr3t-admin-token-value";
const env = { ADMIN_TOKEN: TOKEN } as unknown as Env;

function bearer(token: string): Headers {
  const h = new Headers();
  h.set("authorization", `Bearer ${token}`);
  return h;
}

describe("verifyAdmin · constant-time token compare", () => {
  it("accepts the correct bearer token", () => {
    expect(() => verifyAdmin(env, bearer(TOKEN))).not.toThrow();
  });

  it("rejects a wrong token of equal length", () => {
    const wrong = "x".repeat(TOKEN.length);
    expect(() => verifyAdmin(env, bearer(wrong))).toThrow(AppError);
  });

  it("rejects tokens of wrong length (no early-return length leak)", () => {
    expect(() => verifyAdmin(env, bearer("short"))).toThrow(AppError);
    expect(() => verifyAdmin(env, bearer(TOKEN + "-extra-tail"))).toThrow(AppError);
  });

  it("rejects when no auth header is present", () => {
    expect(() => verifyAdmin(env, new Headers())).toThrow(/missing bearer/);
  });
});

describe("verifyAdmin · ?token= scoping", () => {
  it("ignores ?token= when no url is passed (non-evidence routers)", () => {
    // Router middleware for non-evidence admin routes calls verifyAdmin WITHOUT url,
    // so a query-only token must be rejected as 'missing bearer token'.
    expect(() => verifyAdmin(env, new Headers())).toThrow(/missing bearer/);
  });

  it("accepts ?token= only when url is passed (evidence route)", () => {
    const url = new URL(`https://x/admin/stats/evidence/abc?token=${TOKEN}`);
    expect(() => verifyAdmin(env, new Headers(), url)).not.toThrow();
  });

  it("rejects a wrong ?token= even on the evidence route", () => {
    const url = new URL("https://x/admin/stats/evidence/abc?token=nope");
    expect(() => verifyAdmin(env, new Headers(), url)).toThrow(AppError);
  });
});
