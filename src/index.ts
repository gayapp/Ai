import { Hono } from "hono";
import archHtml from "../docs/architecture.html";
import { AppError, ErrorCodes } from "./lib/errors.ts";
import { moderateRouter } from "./routes/moderate.ts";
import { adminAppsRouter } from "./routes/admin-apps.ts";
import { adminPromptsRouter } from "./routes/admin-prompts.ts";
import { adminStatsRouter } from "./routes/admin-stats.ts";
import { executeModeration } from "./moderation/pipeline.ts";
import {
  computeContentHash,
  dedupKey,
  getDedup,
  putDedup,
} from "./moderation/dedup.ts";
import {
  loadActivePromptCached,
  recordCompleted,
  getModerationById,
  recordPending,
} from "./db/queries.ts";
import { getRoute } from "./providers/router.ts";
import { CachedResult } from "./moderation/schema.ts";
import { processCallback } from "./callback/dispatcher.ts";
import type { CallbackJob, ModerationJob } from "./moderation/types.ts";

// ==========================================================
// HTTP router
// ==========================================================
const app = new Hono<{ Bindings: Env }>({ strict: false });

app.get("/", (c) => c.text("ai-guard — see /architecture\n"));
app.get("/health", (c) =>
  c.json({ ok: true, ts: new Date().toISOString(), version: "0.1.0" }),
);
app.get("/architecture", (c) =>
  c.html(archHtml, 200, {
    "cache-control": "public, max-age=300",
  }),
);

app.route("/", moderateRouter);
app.route("/admin/apps", adminAppsRouter);
app.route("/admin/prompts", adminPromptsRouter);
app.route("/admin/stats", adminStatsRouter);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.status as 400 | 401 | 403 | 404 | 500);
  }
  // zod parse errors
  if (err && typeof err === "object" && "issues" in err) {
    return c.json(
      { error_code: ErrorCodes.INVALID_REQUEST, message: "validation failed", details: (err as { issues: unknown }).issues },
      400,
    );
  }
  console.error("[unhandled]", err);
  return c.json(
    { error_code: ErrorCodes.INTERNAL, message: "internal error" },
    500,
  );
});

// ==========================================================
// Queue consumers
// ==========================================================
async function handleModerationQueue(
  batch: MessageBatch<ModerationJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      await runAsyncModeration(env, job);
      msg.ack();
    } catch (e) {
      console.error("[moderation-queue] failed", job.request_id, e);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function runAsyncModeration(env: Env, job: ModerationJob): Promise<void> {
  const existing = await getModerationById(env.DB, job.request_id);
  if (!existing) {
    await recordPending(env.DB, {
      id: job.request_id,
      app_id: job.app_id,
      biz_type: job.biz_type,
      biz_id: job.biz_id,
      user_id: job.user_id,
      content_hash: await computeContentHash(job.biz_type, job.content),
      mode: "async",
      extra: job.extra ?? null,
      callback_url: job.callback_url,
    });
  }

  const isImage = job.biz_type === "avatar";
  const contentHash = existing?.content_hash ?? await computeContentHash(job.biz_type, job.content);

  // Dedup check (again — KV may have populated since request acceptance)
  const route = getRoute(job.biz_type);
  const primaryPrompt = await loadActivePromptCached(env, job.biz_type, route.primary);
  const kvKey = primaryPrompt ? dedupKey(job.biz_type, primaryPrompt.version, contentHash) : null;
  if (kvKey) {
    const cached = await getDedup(env.DEDUP_CACHE, kvKey);
    if (cached) {
      await recordCompleted(env.DB, {
        id: job.request_id,
        cached: true,
        status: cached.status,
        risk_level: cached.risk_level,
        categories: cached.categories,
        reason: cached.reason,
        provider: cached.provider,
        model: cached.model,
        prompt_version: cached.prompt_version,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: null,
      });
      await env.CALLBACK_QUEUE.send({ request_id: job.request_id, attempt: 0 });
      return;
    }
  }

  const timeoutMs = parseInt(env.SYNC_TIMEOUT_MS || "10000", 10);
  try {
    const result = await executeModeration(env, {
      bizType: job.biz_type,
      content: job.content,
      isImage,
      timeoutMs: Math.max(timeoutMs, 25_000), // give async a bit more
    });
    await recordCompleted(env.DB, {
      id: job.request_id,
      cached: false,
      status: result.status,
      risk_level: result.risk_level,
      categories: result.categories,
      reason: result.reason,
      provider: result.provider,
      model: result.model,
      prompt_version: result.prompt_version,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      latency_ms: result.latency_ms,
      error_code: result.error_code ?? null,
    });
    if (kvKey && result.status !== "error") {
      const cacheable = CachedResult.parse({
        status: result.status,
        risk_level: result.risk_level,
        categories: result.categories,
        reason: result.reason,
        provider: result.provider,
        model: result.model,
        prompt_version: result.prompt_version,
      });
      const ttl = parseInt(env.DEDUP_TTL_SECONDS || "604800", 10);
      await putDedup(env.DEDUP_CACHE, kvKey, cacheable, ttl);
    }
  } catch (e) {
    const code = e instanceof AppError ? e.code : ErrorCodes.INTERNAL;
    const msg = e instanceof Error ? e.message : String(e);
    await recordCompleted(env.DB, {
      id: job.request_id,
      cached: false,
      status: "error",
      risk_level: null,
      categories: [],
      reason: msg.slice(0, 256),
      provider: null,
      model: null,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_code: code,
    });
  }

  await env.CALLBACK_QUEUE.send({ request_id: job.request_id, attempt: 0 });
}

async function handleCallbackQueue(
  batch: MessageBatch<CallbackJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processCallback(env, msg.body);
      msg.ack();
    } catch (e) {
      console.warn("[callback-queue] failed", msg.body.request_id, e);
      msg.ack(); // dispatcher already re-enqueues with delay; don't double-retry
    }
  }
}

// ==========================================================
// Scheduled (MVP: simple hourly KV cleanup — stats rollup to be added)
// ==========================================================
async function scheduled(_ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  await env.DB.prepare(
    `DELETE FROM moderation_requests WHERE created_at < ?`,
  )
    .bind(cutoff)
    .run();
  await env.DB.prepare(
    `DELETE FROM callback_deliveries WHERE created_at < ?`,
  )
    .bind(cutoff)
    .run();
}

// ==========================================================
// Worker export
// ==========================================================
const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  async queue(batch, env) {
    if (batch.queue.endsWith("moderation")) {
      await handleModerationQueue(batch as unknown as MessageBatch<ModerationJob>, env);
    } else if (batch.queue.endsWith("callback")) {
      await handleCallbackQueue(batch as unknown as MessageBatch<CallbackJob>, env);
    } else {
      console.warn("[queue] unknown queue", batch.queue);
    }
  },
  scheduled,
};

export default handler;
