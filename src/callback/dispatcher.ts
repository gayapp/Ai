import {
  getModerationById,
  loadAppCached,
  recordCallbackResult,
  upsertCallbackDelivery,
} from "../db/queries.ts";
import { CallbackBody, Category, RiskLevel, type CallbackBody as CallbackBodyT } from "../moderation/schema.ts";
import type { CallbackJob } from "../moderation/types.ts";
import { signCallbackBody } from "./signer.ts";

/** Backoff schedule (minutes) — 1, 5, 30, 120, 720. */
const BACKOFF_MIN = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length;

export async function processCallback(env: Env, job: CallbackJob): Promise<void> {
  const row = await getModerationById(env.DB, job.request_id);
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

  await upsertCallbackDelivery(env.DB, row.id, url);

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
    extra: row.extra ? safeJson(row.extra) : undefined,
    created_at: new Date(row.completed_at ?? row.created_at).toISOString(),
  });

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
        "x-app-id": row.app_id,
        "x-request-id": row.id,
        "x-timestamp": Math.floor(startedAt / 1000).toString(),
        "x-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    status_code = res.status;
    if (res.ok) {
      await recordCallbackResult(env.DB, row.id, {
        status_code,
        attempts: attemptsNow,
        last_error: null,
        delivered_at: Date.now(),
        next_retry_at: null,
      });
      return;
    }
    last_error = `http ${res.status}`;
  } catch (e) {
    last_error = e instanceof Error ? e.message : String(e);
  }

  if (attemptsNow >= MAX_ATTEMPTS) {
    await recordCallbackResult(env.DB, row.id, {
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
  await recordCallbackResult(env.DB, row.id, {
    status_code,
    attempts: attemptsNow,
    last_error,
    delivered_at: null,
    next_retry_at: nextRetryAt,
  });

  // Re-enqueue with explicit delay; throwing also triggers Queue retry
  await env.CALLBACK_QUEUE.send(
    { request_id: row.id, attempt: attemptsNow },
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

function toProviderOrNull(s: string | null): "grok" | "gemini" | null {
  return s === "grok" || s === "gemini" ? s : null;
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
