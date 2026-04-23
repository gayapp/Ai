import { Hono } from "hono";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import {
  getModerationById,
  listModeration,
  summarize,
  topUsers,
} from "../db/queries.ts";
import { BizType, Status } from "../moderation/schema.ts";

export const adminStatsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminStatsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
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
  });
});

adminStatsRouter.get("/requests", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const bizParam = c.req.query("biz_type");
  const statusParam = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const rows = await listModeration(c.env.DB, {
    app_id: c.req.query("app_id"),
    biz_type: bizParam ? BizType.parse(bizParam) : undefined,
    status: statusParam ? Status.parse(statusParam) : undefined,
    from_ms,
    to_ms,
    limit,
  });
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      app_id: r.app_id,
      biz_type: r.biz_type,
      biz_id: r.biz_id,
      user_id: r.user_id,
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
    content_hash: row.content_hash,
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
