import { AppError, ErrorCodes } from "../lib/errors.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../lib/hash.ts";
import { loadAppCached } from "../db/queries.ts";
import type { AppConfig } from "../moderation/types.ts";

const CLOCK_SKEW_SEC = 300;

/** Verifies the inbound `/v1/moderate*` request HMAC and returns the app config. */
export async function verifyAppRequest(
  env: Env,
  headers: Headers,
  rawBody: string,
): Promise<AppConfig> {
  const appId = headers.get("x-app-id");
  const ts = headers.get("x-timestamp");
  const nonce = headers.get("x-nonce");
  const sig = headers.get("x-signature");

  if (!appId || !ts || !nonce || !sig) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "missing auth headers");
  }
  const tsNum = parseInt(ts, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > CLOCK_SKEW_SEC) {
    throw new AppError(ErrorCodes.EXPIRED_TIMESTAMP, 401, "timestamp out of range");
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(nonce)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "bad nonce format");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "bad signature format");
  }

  const app = await loadAppCached(env, appId);
  if (!app) throw new AppError(ErrorCodes.APP_NOT_FOUND, 404, "app not found");
  if (app.disabled) throw new AppError(ErrorCodes.APP_DISABLED, 403, "app disabled");

  const bodyHash = await sha256Hex(rawBody);
  const stringToSign = `${ts}\n${nonce}\n${bodyHash}`;
  const expected = await hmacSha256Hex(app.secret, stringToSign);
  if (!timingSafeEqualHex(expected, sig.toLowerCase())) {
    throw new AppError(ErrorCodes.BAD_SIGNATURE, 401, "signature mismatch");
  }

  // Replay protection
  const nonceKey = `nonce:${appId}:${nonce}`;
  const seen = await env.NONCE.get(nonceKey);
  if (seen) {
    throw new AppError(ErrorCodes.REPLAY_NONCE, 401, "nonce replayed");
  }
  await env.NONCE.put(nonceKey, "1", { expirationTtl: CLOCK_SKEW_SEC + 60 });

  return app;
}

/** Verifies the admin token for /admin/* routes.
 *  Accepts either `Authorization: Bearer <token>` header (primary) or
 *  `?token=<token>` query param (for <img src> use on same-origin pages).
 */
export function verifyAdmin(env: Env, headers: Headers, url?: URL): void {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    throw new AppError(ErrorCodes.INTERNAL, 500, "ADMIN_TOKEN not configured");
  }
  let token: string | null = null;
  const authz = headers.get("authorization");
  const prefix = "Bearer ";
  if (authz && authz.startsWith(prefix)) {
    token = authz.slice(prefix.length);
  } else if (url) {
    const q = url.searchParams.get("token");
    if (q) token = q;
  }
  if (!token) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 401, "missing bearer token");
  }
  if (token.length !== expected.length) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 401, "bad admin token");
  }
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 401, "bad admin token");
  }
}
