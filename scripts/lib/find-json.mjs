#!/usr/bin/env node
// Usage: find-json.mjs <file> <matchKey> <matchValue> <returnKey>
// Reads a JSON array from <file>, finds first element where obj[matchKey] === matchValue,
// prints obj[returnKey] to stdout. Exits 1 if not found (but prints nothing).
import { readFileSync } from "node:fs";
const [, , file, matchKey, matchValue, returnKey] = process.argv;
if (!file || !matchKey || matchValue === undefined || !returnKey) {
  console.error("usage: find-json.mjs <file> <matchKey> <matchValue> <returnKey>");
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
const data = JSON.parse(raw);
const arr = Array.isArray(data) ? data : data.result ?? [];
const found = arr.find((x) => String(x[matchKey]) === String(matchValue));
if (!found) {
  process.exit(1);
}
const val = found[returnKey];
if (val === undefined || val === null) process.exit(1);
process.stdout.write(String(val));
