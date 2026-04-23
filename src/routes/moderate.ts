import { Hono } from "hono";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { verifyAppRequest } from "../auth/hmac.ts";
import { enforceRateLimit } from "../auth/rate-limit.ts";
import {
  ModerateRequestSchema,
  CachedResult,
  type ExecutionResult,
  type ModerateRequest,
} from "../moderation/schema.ts";
import {
  computeContentHash,
  dedupKey,
  getDedup,
  putDedup,
} from "../moderation/dedup.ts";
import { applyPrefilter } from "../moderation/prefilter.ts";
import { executeModeration } from "../moderation/pipeline.ts";
import {
  recordCompleted,
  recordPending,
  getModerationById,
  loadActivePromptCached,
} from "../db/queries.ts";
import { uuidv7 } from "../lib/id.ts";
import { resolveRoute } from "../providers/router.ts";

export const moderateRouter = new Hono<{ Bindings: Env }>();

moderateRouter.post("/v1/moderate", async (c) => {
  const rawBody = await c.req.text();
  const app = await verifyAppRequest(c.env, c.req.raw.headers, rawBody);
  await enforceRateLimit(c.env.NONCE, app.id, app.rate_limit_qps);

  let parsed: ModerateRequest;
  try {
    const json = JSON.parse(rawBody) as unknown;
    parsed = ModerateRequestSchema.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, msg);
  }

  if (!app.biz_types.includes(parsed.biz_type)) {
    throw new AppError(
      ErrorCodes.BIZ_TYPE_NOT_ALLOWED,
      403,
      `biz_type '${parsed.biz_type}' not enabled for this app`,
    );
  }

  const isImage = parsed.biz_type === "avatar";
  const requestId = uuidv7();
  const contentHash = await computeContentHash(parsed.biz_type, parsed.content);
  const callbackUrl = parsed.callback_url ?? app.callback_url;

  // ==== 前置参数校验（必须在 recordPending 之前，否则失败时留残单）====
  // avatar / mode=async 都需要 callback_url（auto+avatar 也会降级成 async）
  const willRequireCallback =
    parsed.mode === "async" || (parsed.mode === "auto" && isImage);
  if (willRequireCallback && !callbackUrl) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      "async mode requires callback_url (on request or on app config)",
    );
  }

  // ==== P1.1 前置漏斗：L1 低信噪 / L2 高置信广告 ====
  const pf = applyPrefilter(parsed.biz_type, parsed.content);

  // Record pending（含 prefilter tag，便于观测）
  await recordPending(c.env.DB, {
    id: requestId,
    app_id: app.id,
    biz_type: parsed.biz_type,
    biz_id: parsed.biz_id,
    user_id: parsed.user_id ?? null,
    content_hash: contentHash,
    content_text: parsed.content,
    mode: parsed.mode,
    extra: parsed.extra ?? null,
    callback_url: callbackUrl,
    prefiltered_by: pf.tag,
  });

  // 命中漏斗直接返回，不打模型、不查 dedup
  if (pf.kind !== "skip" && pf.result) {
    await recordCompleted(c.env.DB, {
      id: requestId,
      cached: false,
      status: pf.result.status,
      risk_level: pf.result.risk_level,
      categories: pf.result.categories,
      reason: pf.result.reason,
      provider: pf.result.provider,
      model: pf.result.model,
      prompt_version: pf.result.prompt_version,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_code: null,
    });
    return c.json({
      request_id: requestId,
      cached: false,
      prefiltered_by: pf.tag,
      result: {
        status: pf.result.status,
        risk_level: pf.result.risk_level,
        categories: pf.result.categories,
        reason: pf.result.reason,
      },
    });
  }

  // Try dedup. Uses PRIMARY provider's active prompt_version for the key
  // (fallback results are still cacheable but keyed by primary's version —
  // this is fine because primary is what "future identical requests" will try).
  const route = resolveRoute(parsed.biz_type, app.provider_strategy);
  const primaryPrompt = await loadActivePromptCached(c.env, parsed.biz_type, route.primary);
  const kvKey = primaryPrompt
    ? dedupKey(parsed.biz_type, route.primary, primaryPrompt.version, contentHash)
    : null;
  if (kvKey) {
    const cached = await getDedup(c.env.DEDUP_CACHE, kvKey);
    if (cached) {
      await recordCompleted(c.env.DB, {
        id: requestId,
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
      return c.json({
        request_id: requestId,
        cached: true,
        result: {
          status: cached.status,
          risk_level: cached.risk_level,
          categories: cached.categories,
          reason: cached.reason,
        },
      });
    }
  }

  // Decide execution path
  const shouldAsync =
    parsed.mode === "async" || (parsed.mode === "auto" && isImage);

  if (shouldAsync) {
    // callbackUrl 已在函数顶部校验过（willRequireCallback）
    await c.env.MODERATION_QUEUE.send({
      request_id: requestId,
      app_id: app.id,
      biz_type: parsed.biz_type,
      biz_id: parsed.biz_id,
      user_id: parsed.user_id ?? null,
      content: parsed.content,
      callback_url: callbackUrl!,
      extra: parsed.extra ?? null,
      created_at_ms: Date.now(),
    });
    return c.json(
      { request_id: requestId, accepted_at: new Date().toISOString() },
      202,
    );
  }

  // Sync execution
  const timeoutMs = parseInt(c.env.SYNC_TIMEOUT_MS || "10000", 10);
  let result: ExecutionResult;
  try {
    result = await executeModeration(c.env, {
      bizType: parsed.biz_type,
      content: parsed.content,
      isImage,
      timeoutMs,
      strategy: app.provider_strategy,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.PROVIDER_TIMEOUT && parsed.mode === "auto") {
      // Auto-downgrade to async（callbackUrl 已预校验保证存在）
      await c.env.MODERATION_QUEUE.send({
        request_id: requestId,
        app_id: app.id,
        biz_type: parsed.biz_type,
        biz_id: parsed.biz_id,
        user_id: parsed.user_id ?? null,
        content: parsed.content,
        callback_url: callbackUrl!,
        extra: parsed.extra ?? null,
        created_at_ms: Date.now(),
      });
      return c.json(
        { request_id: requestId, accepted_at: new Date().toISOString(), downgraded: true },
        202,
      );
    }
    // Record as error so stats don't leak "pending" rows.
    // 用 waitUntil 保证客户端断开后写入也完成
    const code = err instanceof AppError ? err.code : ErrorCodes.INTERNAL;
    const msg = err instanceof Error ? err.message : String(err);
    c.executionCtx.waitUntil(
      recordCompleted(c.env.DB, {
        id: requestId,
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
      }),
    );
    throw err;
  }

  // Persist（用 waitUntil 保证客户端断开后写入也完成，避免 pending 残留）
  c.executionCtx.waitUntil(
    recordCompleted(c.env.DB, {
      id: requestId,
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
    }),
  );

  // Cache non-error successes (and only when we had a dedup key derived from
  // the primary prompt — fallback-only cases skip caching to keep the model set coherent)
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
    const ttl = parseInt(c.env.DEDUP_TTL_SECONDS || "604800", 10);
    await putDedup(c.env.DEDUP_CACHE, kvKey, cacheable, ttl);
  }

  return c.json({
    request_id: requestId,
    cached: false,
    result: {
      status: result.status,
      risk_level: result.risk_level,
      categories: result.categories,
      reason: result.reason,
    },
  });
});

// Query result by id (for async replay)
moderateRouter.get("/v1/moderate/:id", async (c) => {
  const rawBody = ""; // GET — body hash is empty
  const app = await verifyAppRequest(c.env, c.req.raw.headers, rawBody);
  const id = c.req.param("id");
  const row = await getModerationById(c.env.DB, id);
  if (!row || row.app_id !== app.id) {
    throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  }
  return c.json({
    request_id: row.id,
    status: row.status,
    result: {
      status: row.status,
      risk_level: row.risk_level,
      categories: row.categories ? JSON.parse(row.categories) : [],
      reason: row.reason,
    },
    provider: row.provider,
    model: row.model,
    cached: !!row.cached,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  });
});
