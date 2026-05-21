#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from "node:crypto";
import process from "node:process";

const base = requiredEnv("BASE");
const appId = requiredEnv("APP_ID");
const secret = requiredEnv("SECRET");
const bizType = process.env.BIZ_TYPE ?? "media_intro";
const bizId = process.env.BIZ_ID ?? `smoke-${Date.now()}`;
const mode = process.env.MODE ?? "async";
const deliveryMode = process.env.DELIVERY_MODE ?? "pull";
const timeoutMs = numberEnv("TIMEOUT_MS", 60000);
const pollIntervalMs = numberEnv("POLL_INTERVAL_MS", 2000);
const expectStatuses = new Set((process.env.EXPECT_STATUS ?? "ok,error").split(",").map((s) => s.trim()));
const shouldAck = process.env.ACK !== "0" && deliveryMode !== "callback";

const payload = {
  biz_type: bizType,
  biz_id: bizId,
  input: parseInput(),
  mode,
  delivery_mode: deliveryMode,
  ...(process.env.CALLBACK_URL ? { callback_url: process.env.CALLBACK_URL } : {}),
};

const submit = await signedFetch("/v1/analyze", {
  method: "POST",
  body: JSON.stringify(payload),
});
const submitBody = await readJson(submit);
if (!submit.ok) {
  console.error(JSON.stringify(submitBody, null, 2));
  process.exit(1);
}

const requestId = submitBody.request_id;
if (!requestId) {
  console.error("submit response missing request_id");
  console.error(JSON.stringify(submitBody, null, 2));
  process.exit(1);
}

console.log(`submitted request_id=${requestId} http=${submit.status}`);
if (submit.status === 200 && submitBody.result) {
  console.log(JSON.stringify(submitBody, null, 2));
  process.exit(0);
}

const deadline = Date.now() + timeoutMs;
let finalBody = null;
while (Date.now() < deadline) {
  await sleep(pollIntervalMs);
  const poll = await signedFetch(`/v1/analyze/${encodeURIComponent(requestId)}`, { method: "GET" });
  const pollBody = await readJson(poll);
  if (!poll.ok) {
    console.error(JSON.stringify(pollBody, null, 2));
    process.exit(1);
  }
  console.log(`poll status=${pollBody.status}`);
  if (pollBody.status !== "pending") {
    finalBody = pollBody;
    break;
  }
}

if (!finalBody) {
  console.error(`request ${requestId} did not complete within ${timeoutMs}ms`);
  process.exit(2);
}

console.log(JSON.stringify(finalBody, null, 2));
if (!expectStatuses.has(finalBody.status)) {
  console.error(`unexpected final status '${finalBody.status}', expected one of ${[...expectStatuses].join(",")}`);
  process.exit(2);
}

if (shouldAck) {
  const ack = await signedFetch(`/v1/analyze/${encodeURIComponent(requestId)}/ack`, {
    method: "POST",
    body: "",
  });
  const ackBody = await readJson(ack);
  if (!ack.ok) {
    console.error(JSON.stringify(ackBody, null, 2));
    process.exit(1);
  }
  console.log(`acked request_id=${ackBody.request_id} acked_at=${ackBody.acked_at}`);
}

function parseInput() {
  if (process.env.INPUT_JSON) {
    return JSON.parse(process.env.INPUT_JSON);
  }
  if (bizType === "media_analysis") {
    return {
      image_urls: [requiredEnv("IMAGE_URL")],
      title: "gray smoke",
    };
  }
  return {
    title: "gray smoke",
    tags: ["smoke"],
    max_length: 80,
  };
}

async function signedFetch(path, opts) {
  const body = opts.body ?? "";
  const headers = signHeaders(body);
  if (body) headers.set("content-type", "application/json");
  return await fetch(new URL(path, base), {
    method: opts.method,
    headers,
    ...(body ? { body } : {}),
  });
}

function signHeaders(body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", secret)
    .update(`${ts}\n${nonce}\n${bodyHash}`)
    .digest("hex");
  return new Headers({
    "x-app-id": appId,
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-signature": sig,
  });
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
