#!/usr/bin/env node
import process from "node:process";

const assertMode = process.argv.includes("--assert");
const jsonMode = process.argv.includes("--json");

const base = requiredEnv("BASE");
const adminToken = requiredEnv("ADMIN_TOKEN");
const url = new URL("/admin/stats/analyze-gray", base);
appendParam(url, "app_id", process.env.APP_ID);
appendParam(url, "limit", process.env.LIMIT);
appendParam(url, "baseline_p95_ms", process.env.BASELINE_P95_MS);

if (process.env.FROM) {
  url.searchParams.set("from", process.env.FROM);
}
if (process.env.TO) {
  url.searchParams.set("to", process.env.TO);
}
if (!process.env.FROM && !process.env.TO) {
  const hours = numberEnv("WINDOW_HOURS", 24);
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600 * 1000);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
}

const res = await fetch(url, {
  headers: { authorization: `Bearer ${adminToken}` },
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  console.error(text);
  process.exit(1);
}

if (!res.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

if (jsonMode) {
  console.log(JSON.stringify(body, null, 2));
} else {
  printReport(body);
}

if (assertMode && !body.ready_for_next_stage) {
  console.error("Gray gate failed. Keep the current rollout stage and inspect the failed gates above.");
  process.exit(2);
}

function printReport(body) {
  console.log(`Analyze gray report ${body.from} -> ${body.to}`);
  console.log(`app=${body.app_id ?? "all"} samples=${body.sample_size} ready=${body.ready_for_next_stage}`);
  console.log(
    `status ok=${body.status.by_status.ok} error=${body.status.by_status.error} pending=${body.status.by_status.pending} error_rate=${pct(body.status.error_rate)}`,
  );
  console.log(
    `latency p50=${fmt(body.latency_ms.p50)}ms p95=${fmt(body.latency_ms.p95)}ms p99=${fmt(body.latency_ms.p99)}ms baseline_ratio=${fmt(body.baseline.p95_ratio)}`,
  );
  console.log(
    `output_tokens p50=${fmt(body.tokens.output.p50)} p95=${fmt(body.tokens.output.p95)} p99=${fmt(body.tokens.output.p99)} max=${fmt(body.tokens.output.max)}`,
  );
  console.log(`dedup hit_rate=${pct(body.dedup.hit_rate)} cached=${body.dedup.cached}`);
  console.log(`delivery callback_undelivered=${body.delivery.callback_undelivered} pull_unacked=${body.delivery.pull_unacked}`);
  console.log(`error_codes=${JSON.stringify(body.error_codes)}`);
  console.log(`by_biz_type=${JSON.stringify(body.by_biz_type)}`);
  console.log(`gates=${JSON.stringify(body.gates)}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function appendParam(url, name, value) {
  if (value) url.searchParams.set(name, value);
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fmt(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function pct(value) {
  return `${((value ?? 0) * 100).toFixed(2)}%`;
}
