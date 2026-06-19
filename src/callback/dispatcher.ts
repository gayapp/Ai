import {
  getModerationById,
  loadAppCached,
  recordCallbackResult,
  upsertCallbackDelivery,
  type ModerationRow,
} from "../db/queries.ts";
import {
  getAnalyzeById,
  markAnalyzeDelivered,
} from "../db/analyze-requests.ts";
import { AnalyzeCallbackBody, type AnalyzeCallbackBody as AnalyzeCallbackBodyT } from "../analyze/schema/callback.ts";
import { analyzeErrorMessage } from "../analyze/pipeline/dispatcher.ts";
import type { AnalyzeRow } from "../analyze/types.ts";
import { CallbackBody, Category, ModerationLabel, RiskLevel, type CallbackBody as CallbackBodyT } from "../moderation/schema.ts";
import type { AppConfig, CallbackJob } from "../moderation/types.ts";
import { signCallbackBody } from "./signer.ts";

/** Backoff schedule (minutes) — 1, 5, 30, 120, 720. */
const BACKOFF_MIN = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length;

export async function processCallback(env: Env, job: CallbackJob): Promise<void> {
  const row = await getModerationById(env.DB, job.request_id);
  if (row) {
    await processModerationCallback(env, job, row);
    return;
  }

  const analyze = await getAnalyzeById(env.DB, job.request_id);
  if (analyze) {
    await processAnalyzeCallback(env, job, analyze);
    return;
  }

  console.warn("[callback] request not found", job.request_id);
}

async function processModerationCallback(
  env: Env,
  job: CallbackJob,
  row: ModerationRow,
): Promise<void> {
  if (!row) {
    console.warn("[callback] moderation not found", job.request_id);
    return;
  }
  const app = await loadAppCached(env, row.app_id);
  if (!app) {
    console.warn("[callback] app not found", row.app_id);
    return;
  }
  const url = row.callback_url || app.callback_url;
  if (!url) {
    console.warn("[callback] no url for", job.request_id);
    return;
  }

  const body: CallbackBodyT = CallbackBody.parse({
    schema_version: "1.0",
    request_id: row.id,
    app_id: row.app_id,
    biz_type: row.biz_type,
    biz_id: row.biz_id,
    user_id: row.user_id,
    status: row.status,
    risk_level: toRiskLevelOrNull(row.risk_level),
    categories: toCategories(row.categories),
    reason: row.reason ?? "",
    provider: toProviderOrNull(row.provider),
    model: row.model,
    prompt_version: row.prompt_version,
    cached: !!row.cached,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    labels: toLabels(row.labels),
    extra: row.extra ? safeJson(row.extra) : undefined,
    created_at: new Date(row.completed_at ?? row.created_at).toISOString(),
  });

  await postSignedCallback(env, job, app, row.id, url, body);
}

async function processAnalyzeCallback(
  env: Env,
  job: CallbackJob,
  row: AnalyzeRow,
): Promise<void> {
  if (row.delivery_mode === "pull") {
    return;
  }
  if (row.delivered_at) {
    return;
  }
  const app = await loadAppCached(env, row.app_id);
  if (!app) {
    console.warn("[callback] app not found", row.app_id);
    return;
  }
  const url = row.callback_url || app.callback_url;
  if (!url) {
    console.warn("[callback] no url for", job.request_id);
    return;
  }

  const status = row.status === "ok" ? "ok" : "error";
  const result = status === "ok" && row.result_json ? safeJson(row.result_json) : undefined;
  const body: AnalyzeCallbackBodyT = AnalyzeCallbackBody.parse({
    schema_version: "1.1",
    request_id: row.id,
    app_id: row.app_id,
    biz_type: row.biz_type,
    biz_id: row.biz_id,
    user_id: row.user_id,
    status,
    ...(result ? { result } : {}),
    ...(status === "error" ? {
      error_code: row.error_code ?? "unknown",
      message: analyzeErrorMessage(row.error_code),
    } : {}),
    provider: toAnalyzeProviderOrNull(row.provider),
    model: row.model,
    prompt_version: row.prompt_version,
    cached: !!row.cached,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    delivery_mode: row.delivery_mode ?? "both",
    extra: row.extra_json ? safeJson(row.extra_json) : undefined,
    created_at: new Date(row.completed_at ?? row.created_at).toISOString(),
  });

  await postSignedCallback(env, job, app, row.id, url, body, async (deliveredAt) => {
    await markAnalyzeDelivered(env.DB, row.id, deliveredAt);
  });
}

export async function sweepAnalyzeCallbackDeliveries(
  env: Env,
  opts: { staleMs?: number; limit?: number } = {},
): Promise<{ scanned: number; enqueued: number; failed: number }> {
  const now = Date.now();
  const staleCutoff = now - (opts.staleMs ?? 5 * 60 * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await env.DB.prepare(
    `SELECT d.request_id, d.attempts
     FROM callback_deliveries d
     JOIN analyze_requests r ON r.id = d.request_id
     WHERE d.delivered_at IS NULL
       AND r.status IN ('ok','error')
       AND r.delivery_mode IN ('callback','both')
       AND (
         (d.attempts = 0 AND d.created_at < ?)
         OR (d.next_retry_at IS NOT NULL AND d.next_retry_at <= ?)
       )
     ORDER BY d.created_at ASC
     LIMIT ?`,
  )
    .bind(staleCutoff, now, limit)
    .all<{ request_id: string; attempts: number | null }>();

  let enqueued = 0;
  let failed = 0;
  for (const row of results) {
    try {
      await env.CALLBACK_QUEUE.send({
        request_id: row.request_id,
        attempt: Math.max(0, Number(row.attempts ?? 0)),
      });
      enqueued += 1;
    } catch (e) {
      failed += 1;
      console.warn("[callback-sweep] enqueue failed", row.request_id, e);
    }
  }
  return { scanned: results.length, enqueued, failed };
}

async function postSignedCallback(
  env: Env,
  job: CallbackJob,
  app: AppConfig,
  requestId: string,
  url: string,
  body: CallbackBodyT | AnalyzeCallbackBodyT,
  onDelivered?: (deliveredAt: number) => Promise<void>,
): Promise<void> {
  await upsertCallbackDelivery(env.DB, requestId, url);

  const acquired = await acquireCallbackSlot(
    env.DEDUP_CACHE,
    app.id,
    app.callback_max_concurrency,
  );
  if (!acquired) {
    await env.CALLBACK_QUEUE.send(
      { request_id: requestId, attempt: job.attempt },
      { delaySeconds: 5 },
    );
    return;
  }

  const rawBody = JSON.stringify(body);
  const signature = await signCallbackBody(app.secret, rawBody);
  const attemptsNow = job.attempt + 1;
  const startedAt = Date.now();
  let status_code: number | null = null;
  let last_error: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-id": app.id,
        "x-request-id": requestId,
        "x-timestamp": Math.floor(startedAt / 1000).toString(),
        "x-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    status_code = res.status;
    if (res.ok) {
      const deliveredAt = Date.now();
      await recordCallbackResult(env.DB, requestId, {
        status_code,
        attempts: attemptsNow,
        last_error: null,
        delivered_at: deliveredAt,
        next_retry_at: null,
      });
      if (onDelivered) await onDelivered(deliveredAt);
      return;
    }
    last_error = `http ${res.status}`;
  } catch (e) {
    last_error = e instanceof Error ? e.message : String(e);
  } finally {
    await releaseCallbackSlot(env.DEDUP_CACHE, app.id);
  }

  if (attemptsNow >= MAX_ATTEMPTS) {
    await recordCallbackResult(env.DB, requestId, {
      status_code,
      attempts: attemptsNow,
      last_error: `final: ${last_error}`,
      delivered_at: null,
      next_retry_at: null,
    });
    throw new Error(`callback failed permanently: ${last_error}`);
  }

  const nextDelayMin = BACKOFF_MIN[attemptsNow] ?? BACKOFF_MIN[BACKOFF_MIN.length - 1]!;
  const nextRetryAt = Date.now() + nextDelayMin * 60 * 1000;
  await recordCallbackResult(env.DB, requestId, {
    status_code,
    attempts: attemptsNow,
    last_error,
    delivered_at: null,
    next_retry_at: nextRetryAt,
  });

  // Re-enqueue with explicit delay; throwing also triggers Queue retry
  await env.CALLBACK_QUEUE.send(
    { request_id: requestId, attempt: attemptsNow },
    { delaySeconds: nextDelayMin * 60 },
  );
}

function toRiskLevelOrNull(s: string | null): "safe" | "low" | "medium" | "high" | null {
  if (!s) return null;
  const r = RiskLevel.safeParse(s);
  return r.success ? r.data : null;
}

function toCategories(s: string | null): Array<"politics" | "porn" | "abuse" | "ad" | "spam" | "violence" | "other"> {
  if (!s) return [];
  try {
    const arr = JSON.parse(s) as unknown[];
    const out: Array<"politics" | "porn" | "abuse" | "ad" | "spam" | "violence" | "other"> = [];
    for (const x of arr) {
      const r = Category.safeParse(x);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** 解析库里存的 labels JSON（post）。无/不合规返回 undefined（回调里省略该字段）。 */
function toLabels(s: string | null): ModerationLabel[] | undefined {
  if (!s) return undefined;
  try {
    const arr = JSON.parse(s) as unknown[];
    if (!Array.isArray(arr)) return undefined;
    const out: ModerationLabel[] = [];
    for (const x of arr) {
      const r = ModerationLabel.safeParse(x);
      if (r.success) out.push(r.data);
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

function toProviderOrNull(s: string | null): "grok" | "gemini" | null {
  return s === "grok" || s === "gemini" ? s : null;
}

function toAnalyzeProviderOrNull(s: string | null): "grok" | "gemini" | "xai" | null {
  return s === "grok" || s === "gemini" || s === "xai" ? s : null;
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function acquireCallbackSlot(
  kv: KVNamespace,
  appId: string,
  maxConcurrency: number,
): Promise<boolean> {
  const key = `callback:inflight:${appId}`;
  const max = Math.max(1, maxConcurrency || 10);
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  if (current >= max) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 60 });
  return true;
}

async function releaseCallbackSlot(kv: KVNamespace, appId: string): Promise<void> {
  const key = `callback:inflight:${appId}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  await kv.put(key, String(Math.max(0, current - 1)), { expirationTtl: 60 });
}
