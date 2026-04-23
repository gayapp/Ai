#!/usr/bin/env node
/**
 * Creates an app via the Admin API and prints the secret (once).
 *
 * Usage:
 *   BASE=https://ai-guard-dev.<subdomain>.workers.dev \
 *   ADMIN_TOKEN=xxx \
 *   node --experimental-transform-types scripts/seed-app.ts "my-forum" \
 *        "https://myapp.com/hooks" "comment,nickname,bio,avatar"
 */

import { randomBytes, createHash, createHmac } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-admin-token";

async function main() {
  const args = process.argv.slice(2);
  const name = args[0] ?? "demo-app";
  const callback = args[1] ?? "https://example.com/hooks/moderate";
  const bizTypes = (args[2] ?? "comment,nickname,bio,avatar").split(",");

  const res = await fetch(`${BASE}/admin/apps/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      name,
      callback_url: callback,
      biz_types: bizTypes,
    }),
  });
  if (!res.ok) {
    console.error(res.status, await res.text());
    process.exit(1);
  }
  const out = await res.json();
  console.log("==============================================");
  console.log("Created app. Save the secret — it is shown ONCE.");
  console.log("==============================================");
  console.log(JSON.stringify(out, null, 2));
  console.log();
  console.log("Example curl:");
  const body = JSON.stringify({ biz_type: "comment", biz_id: "demo-1", content: "你好世界" });
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", (out as { secret: string }).secret)
    .update(`${ts}\n${nonce}\n${bodyHash}`)
    .digest("hex");
  console.log(
    `curl -X POST ${BASE}/v1/moderate \\
  -H 'x-app-id: ${(out as { id: string }).id}' \\
  -H 'x-timestamp: ${ts}' \\
  -H 'x-nonce: ${nonce}' \\
  -H 'x-signature: ${sig}' \\
  -H 'content-type: application/json' \\
  -d '${body}'`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
