#!/usr/bin/env node
/**
 * Generate HMAC signature headers for a request body.
 * Usage:
 *   node scripts/sign-request.mjs <app_id> <secret> '<json body>'
 * Outputs: env-var style so you can eval it, e.g.
 *   eval $(node scripts/sign-request.mjs app_xxx mysecret '{"foo":1}')
 *   curl ... -H "X-App-Id: $X_APP_ID" -H "X-Timestamp: $X_TS" ...
 */
import { randomBytes, createHash, createHmac } from "node:crypto";

const [, , appId, secret, body = "{}"] = process.argv;
if (!appId || !secret) {
  console.error("usage: sign-request.mjs <app_id> <secret> '<body>'");
  process.exit(1);
}
const ts = Math.floor(Date.now() / 1000).toString();
const nonce = randomBytes(16).toString("hex");
const bodyHash = createHash("sha256").update(body).digest("hex");
const sig = createHmac("sha256", secret)
  .update(`${ts}\n${nonce}\n${bodyHash}`)
  .digest("hex");
console.log(`X_APP_ID='${appId}'`);
console.log(`X_TS='${ts}'`);
console.log(`X_NONCE='${nonce}'`);
console.log(`X_SIG='${sig}'`);
console.log(`X_BODY='${body.replace(/'/g, "'\\''")}'`);
