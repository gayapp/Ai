#!/usr/bin/env node
// Usage: patch-toml.mjs <env> <d1Id> <kvDedup> <kvPrompts> <kvApps> <kvNonce>
// Rewrites wrangler.toml placeholders in the correct section (top-level for prod, [env.dev] for dev).
import { readFileSync, writeFileSync } from "node:fs";

const [, , envName, d1Id, kvDedup, kvPrompts, kvApps, kvNonce] = process.argv;
if (!envName || !d1Id || !kvDedup || !kvPrompts || !kvApps || !kvNonce) {
  console.error("usage: patch-toml.mjs <env> <d1Id> <kvDedup> <kvPrompts> <kvApps> <kvNonce>");
  process.exit(2);
}

const TOML = "wrangler.toml";
let src = readFileSync(TOML, "utf8");

// Split on env headers
const parts = src.split(/(\[env\.[a-z]+\]\s*\n)/);
// parts: [topLevel, "[env.dev]\n", devBody, "[env.prod]\n", prodBody, ...]

let targetIdx;
if (envName === "prod") {
  targetIdx = 0;
} else {
  const header = `[env.${envName}]`;
  const hi = parts.findIndex((p) => p.trim() === header);
  if (hi === -1) {
    console.error(`no env section [env.${envName}] found`);
    process.exit(1);
  }
  targetIdx = hi + 1;
}

let body = parts[targetIdx];

// Patch D1 id — first occurrence within the block
body = body.replace(
  /(database_id\s*=\s*")REPLACE_AFTER_BOOTSTRAP(")/,
  `$1${d1Id}$2`,
);

// Patch KV ids — match by binding name
const kvMap = {
  DEDUP_CACHE: kvDedup,
  PROMPTS: kvPrompts,
  APPS: kvApps,
  NONCE: kvNonce,
};
for (const [b, id] of Object.entries(kvMap)) {
  const re = new RegExp(
    `(binding\\s*=\\s*"${b}"\\s*\\n\\s*id\\s*=\\s*")REPLACE_AFTER_BOOTSTRAP(")`,
  );
  body = body.replace(re, `$1${id}$2`);
}

parts[targetIdx] = body;
writeFileSync(TOML, parts.join(""));
console.log(`wrangler.toml patched for env=${envName}`);
