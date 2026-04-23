import { Hono } from "hono";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import {
  getModerationById,
  listModeration,
  loadAppCached,
  summarize,
  topUsers,
} from "../db/queries.ts";
import { BizType, Status } from "../moderation/schema.ts";
import { executeModeration } from "../moderation/pipeline.ts";
import { readEvidence } from "../evidence/r2.ts";

export const adminStatsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminStatsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers, new URL(c.req.url));
  await next();
});

function resolveRange(c: {
  req: { query: (k: string) => string | undefined };
}): { from_ms: number; to_ms: number } {
  const fromQ = c.req.query("from");
  const toQ = c.req.query("to");
  const now = Date.now();
  const to_ms = toQ ? Date.parse(toQ) : now;
  const from_ms = fromQ ? Date.parse(fromQ) : now - 24 * 3600 * 1000;
  return { from_ms, to_ms };
}

adminStatsRouter.get("/summary", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const app_id = c.req.query("app_id") ?? undefined;
  const row = await summarize(c.env.DB, { app_id, from_ms, to_ms });
  const nonErr = row.count_total - row.count_error;

  // Prefilter funnel breakdown
  const prefilterRows = await c.env.DB.prepare(
    `SELECT prefiltered_by, COUNT(*) AS n FROM moderation_requests
     WHERE created_at >= ? AND created_at <= ?
       ${app_id ? "AND app_id = ?" : ""}
     GROUP BY prefiltered_by`,
  )
    .bind(...(app_id ? [from_ms, to_ms, app_id] : [from_ms, to_ms]))
    .all<{ prefiltered_by: string | null; n: number }>();
  const funnel: Record<string, number> = {};
  for (const r of prefilterRows.results) {
    funnel[r.prefiltered_by ?? "model"] = r.n;
  }

  return c.json({
    from: new Date(from_ms).toISOString(),
    to: new Date(to_ms).toISOString(),
    total: row.count_total,
    cached: row.count_cached,
    cache_hit_rate: row.count_total ? +(row.count_cached / row.count_total).toFixed(4) : 0,
    by_status: {
      pass: row.count_pass,
      reject: row.count_reject,
      review: row.count_review,
      error: row.count_error,
    },
    pass_rate: nonErr > 0 ? +(row.count_pass / nonErr).toFixed(4) : 0,
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
    },
    funnel, // { model: N, low_signal: M, "ad:wechat_v_signal": K, ... }
  });
});

adminStatsRouter.get("/requests", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const bizParam = c.req.query("biz_type");
  const statusParam = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const cursor = c.req.query("cursor") ?? undefined;
  const { items, nextCursor } = await listModeration(c.env.DB, {
    app_id: c.req.query("app_id"),
    biz_type: bizParam ? BizType.parse(bizParam) : undefined,
    status: statusParam ? Status.parse(statusParam) : undefined,
    from_ms,
    to_ms,
    limit,
    cursor,
  });
  return c.json({
    items: items.map((r) => ({
      id: r.id,
      app_id: r.app_id,
      biz_type: r.biz_type,
      biz_id: r.biz_id,
      user_id: r.user_id,
      content_text: r.content_text,  // for inline preview
      evidence_key: r.evidence_key,  // for thumbnail
      prefiltered_by: r.prefiltered_by,
      status: r.status,
      risk_level: r.risk_level,
      categories: r.categories ? JSON.parse(r.categories) : [],
      reason: r.reason,
      provider: r.provider,
      model: r.model,
      cached: !!r.cached,
      tokens: { input: r.input_tokens ?? 0, output: r.output_tokens ?? 0 },
      latency_ms: r.latency_ms ?? 0,
      created_at: new Date(r.created_at).toISOString(),
    })),
    next_cursor: nextCursor,
  });
});

adminStatsRouter.get("/requests/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getModerationById(c.env.DB, id);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  return c.json({
    id: row.id,
    app_id: row.app_id,
    biz_type: row.biz_type,
    biz_id: row.biz_id,
    user_id: row.user_id,
    content_text: row.content_text,
    content_hash: row.content_hash,
    evidence_key: row.evidence_key,
    prefiltered_by: row.prefiltered_by,
    prompt_version: row.prompt_version,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    cached: !!row.cached,
    status: row.status,
    risk_level: row.risk_level,
    categories: row.categories ? JSON.parse(row.categories) : [],
    reason: row.reason,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    error_code: row.error_code,
    extra: row.extra ? JSON.parse(row.extra) : null,
    callback_url: row.callback_url,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  });
});

// Stream R2 evidence — admin-only. Uses query ?token=... because <img src>
// can't easily carry Authorization header. Token is validated once and not
// stored; prefer short-lived access via this same-origin endpoint.
adminStatsRouter.get("/evidence/:request_id", async (c) => {
  const row = await getModerationById(c.env.DB, c.req.param("request_id"));
  if (!row || !row.evidence_key) {
    throw new AppError(ErrorCodes.NOT_FOUND, 404, "no evidence");
  }
  return readEvidence(c.env.EVIDENCE, row.evidence_key);
});

// Replay — re-run moderation with current active prompt (non-destructive).
// Does NOT write to D1; result is returned inline. Use this to evaluate
// prompt changes against historical data.
adminStatsRouter.post("/requests/:id/replay", async (c) => {
  const id = c.req.param("id");
  const row = await getModerationById(c.env.DB, id);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  if (!row.content_text) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "content_text missing (pre-migration row)");
  }
  const biz = BizType.parse(row.biz_type);
  const timeoutMs = parseInt(c.env.SYNC_TIMEOUT_MS || "10000", 10);
  const app = await loadAppCached(c.env, row.app_id);
  const started = Date.now();
  const result = await executeModeration(c.env, {
    bizType: biz,
    content: row.content_text,
    isImage: biz === "avatar",
    timeoutMs,
    strategy: app?.provider_strategy ?? "auto",
  });
  // Attach original result for side-by-side compare
  return c.json({
    original: {
      status: row.status,
      risk_level: row.risk_level,
      categories: row.categories ? JSON.parse(row.categories) : [],
      reason: row.reason,
      provider: row.provider,
      model: row.model,
      prompt_version: row.prompt_version,
      latency_ms: row.latency_ms ?? 0,
    },
    replayed: {
      status: result.status,
      risk_level: result.risk_level,
      categories: result.categories,
      reason: result.reason,
      provider: result.provider,
      model: result.model,
      prompt_version: result.prompt_version,
      latency_ms: Date.now() - started,
      tokens: { input: result.input_tokens, output: result.output_tokens },
      error_code: result.error_code ?? null,
    },
    changed: row.status !== result.status,
  });
});

adminStatsRouter.get("/callbacks", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
  const onlyFailed = c.req.query("failed") === "1";
  const where = onlyFailed ? " WHERE delivered_at IS NULL " : "";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM callback_deliveries${where} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json({
    items: results.map((r) => ({
      request_id: r.request_id,
      url: r.url,
      status_code: r.status_code,
      attempts: r.attempts,
      last_error: r.last_error,
      next_retry_at: r.next_retry_at ? new Date(Number(r.next_retry_at)).toISOString() : null,
      delivered_at: r.delivered_at ? new Date(Number(r.delivered_at)).toISOString() : null,
      created_at: new Date(Number(r.created_at)).toISOString(),
    })),
  });
});

adminStatsRouter.get("/top-users", async (c) => {
  const app_id = c.req.query("app_id");
  if (!app_id) return c.json({ items: [] });
  const { from_ms, to_ms } = resolveRange(c);
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const items = await topUsers(c.env.DB, { app_id, from_ms, to_ms, limit });
  return c.json({ items });
});
