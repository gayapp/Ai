import { Hono } from "hono";
import { z } from "zod";
import { ANALYZE_BIZ_TYPES, DELIVERY_MODE } from "../analyze/schema/envelope.ts";
import {
  getAdminAnalyzeRequest,
  listAdminAnalyzeRequests,
} from "../db/admin-analyze-queries.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import type { AnalyzeRow } from "../analyze/types.ts";

export const adminAnalyzeRecordsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminAnalyzeRecordsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers, new URL(c.req.url));
  await next();
});

const ListAnalyzeQuery = z.object({
  app_id: z.string().min(1).optional(),
  biz_type: z.enum(ANALYZE_BIZ_TYPES).optional(),
  biz_id: z.string().min(1).optional(),
  status: z.enum(["pending", "ok", "error"]).optional(),
  delivery_mode: z.enum(DELIVERY_MODE).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().min(1).optional(),
});

adminAnalyzeRecordsRouter.get("/", async (c) => {
  const q = ListAnalyzeQuery.parse(normalizeQuery(c.req.query()));
  const { items, nextCursor } = await listAdminAnalyzeRequests(c.env.DB, {
    app_id: q.app_id,
    biz_type: q.biz_type,
    biz_id: q.biz_id,
    status: q.status,
    delivery_mode: q.delivery_mode,
    from_ms: q.from ? Date.parse(q.from) : undefined,
    to_ms: q.to ? Date.parse(q.to) : undefined,
    limit: q.limit,
    cursor: q.cursor,
  });
  return c.json({
    items: items.map(formatAnalyzeListRow),
    next_cursor: nextCursor,
  });
});

adminAnalyzeRecordsRouter.get("/:id", async (c) => {
  const row = await getAdminAnalyzeRequest(c.env.DB, c.req.param("id"));
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "analyze request not found");
  return c.json(formatAnalyzeDetail(row));
});

function normalizeQuery(query: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v || undefined]));
}

function formatAnalyzeListRow(row: AnalyzeRow): Record<string, unknown> {
  return {
    request_id: row.id,
    app_id: row.app_id,
    biz_type: row.biz_type,
    biz_id: row.biz_id,
    user_id: row.user_id,
    mode: row.mode,
    status: row.status,
    provider: row.provider,
    model: row.model,
    cached: !!row.cached,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    error_code: row.error_code,
    delivery_mode: row.delivery_mode ?? "both",
    delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function formatAnalyzeDetail(row: AnalyzeRow): Record<string, unknown> {
  return {
    ...formatAnalyzeListRow(row),
    input_hash: row.input_hash,
    prompt_version: row.prompt_version,
    callback_url: row.callback_url,
    extra: safeJson(row.extra_json),
    input: safeJson(row.input_json),
    result: safeJson(row.result_json),
  };
}

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
