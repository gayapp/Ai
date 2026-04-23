#!/usr/bin/env node
/**
 * Publish prompts-v3 to either prod or dev via Admin API.
 *
 * Usage:
 *   AI_GUARD_BASE=https://aicenter-api.1.gay \
 *   AI_GUARD_ADMIN=<prod_admin_token> \
 *     node scripts/publish-prompts-v3.mjs
 *
 * Each (biz_type, provider) gets version+=1 and becomes active.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const BASE = process.env.AI_GUARD_BASE;
const ADMIN = process.env.AI_GUARD_ADMIN;
if (!BASE || !ADMIN) {
  console.error("Set AI_GUARD_BASE and AI_GUARD_ADMIN env vars.");
  process.exit(1);
}

const PAIRS = [
  ["comment", "grok"],
  ["nickname", "grok"],
  ["bio", "grok"],
  ["avatar", "gemini"],
  ["comment", "gemini"],
  ["nickname", "gemini"],
  ["bio", "gemini"],
];

async function publish(biz, prov) {
  const file = join(ROOT, "docs/optimization/prompts-v3", `${biz}-${prov}.md`);
  const content = readFileSync(file, "utf8").trim();
  const payload = { biz_type: biz, provider: prov, content, created_by: "adult-platform-v3" };
  const res = await fetch(`${BASE}/admin/prompts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
  return data;
}

console.log(`Publishing v3 prompts to ${BASE}`);
console.log("");
for (const [biz, prov] of PAIRS) {
  try {
    const r = await publish(biz, prov);
    console.log(
      `✓ ${biz.padEnd(10)} × ${prov.padEnd(8)} → v${r.version} (id=${r.id}, ${
        r.is_active ? "active" : "inactive"
      })`,
    );
  } catch (e) {
    console.error(`✗ ${biz} × ${prov}: ${e.message}`);
  }
}
console.log("");
console.log("All done.  PROMPTS KV will refresh within 60s (or force by invalidating).");
