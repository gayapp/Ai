import { Hono } from "hono";
import { z } from "zod";
import { ANALYZE_BIZ_TYPES, DELIVERY_MODE } from "../analyze/schema/envelope.ts";
import { canonicalJson, computeInputHash } from "../analyze/dedup.ts";
import type { AnalyzeBizType, AnalyzeRow, DeliveryMode } from "../analyze/types.ts";
import {
  getAdminAnalyzeRequest,
  listAdminAnalyzeRequests,
  listAnalyzeReprocessCandidates,
} from "../db/admin-analyze-queries.ts";
import { insertAnalyzePending } from "../db/analyze-requests.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { uuidv7 } from "../lib/id.ts";

export const adminAnalyzeRecordsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminAnalyzeRecordsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers); // 仅头部鉴权（?token= 仅 evidence 路由允许）
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
  const { items, nextCursor, total } = await listAdminAnalyzeRequests(c.env.DB, {
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
    total,
  });
});

const ReprocessAnalyzeSchema = z.object({
  app_id: z.string().min(1).optional(),
  biz_type: z.enum(ANALYZE_BIZ_TYPES).optional(),
  error_code: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  dry_run: z.boolean().default(false),
  latest_per_biz: z.boolean().default(true),
  only_without_later_ok: z.boolean().default(true),
});

adminAnalyzeRecordsRouter.post("/reprocess", async (c) => {
  const body = ReprocessAnalyzeSchema.parse(await c.req.json().catch(() => ({})));
  const { items, nextCursor } = await listAnalyzeReprocessCandidates(c.env.DB, {
    app_id: body.app_id,
    biz_type: body.biz_type,
    error_code: body.error_code,
    from_ms: body.from ? Date.parse(body.from) : undefined,
    to_ms: body.to ? Date.parse(body.to) : undefined,
    limit: body.limit,
    cursor: body.cursor,
    latest_per_biz: body.latest_per_biz,
    only_without_later_ok: body.only_without_later_ok,
  });

  const reprocessed: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const row of items) {
    const input = safeJson(row.input_json);
    const bizType = toAnalyzeBizType(row.biz_type);
    const deliveryMode = toDeliveryMode(row.delivery_mode);
    if (!input || !bizType || !deliveryMode) {
      skipped.push({
        request_id: row.id,
        biz_id: row.biz_id,
        reason: !input ? "invalid_input_json" : !bizType ? "invalid_biz_type" : "invalid_delivery_mode",
      });
      continue;
    }
    if (body.dry_run) {
      reprocessed.push({
        original_request_id: row.id,
        biz_id: row.biz_id,
        error_code: row.error_code,
      });
      continue;
    }

    const requestId = uuidv7();
    const inputJson = canonicalJson(input);
    const inputHash = await computeInputHash(input);
    await insertAnalyzePending(c.env.DB, {
      id: requestId,
      app_id: row.app_id,
      biz_type: bizType,
      biz_id: row.biz_id,
      user_id: row.user_id,
      input_hash: inputHash,
      input_json: inputJson,
      mode: "async",
      delivery_mode: deliveryMode,
      callback_url: row.callback_url,
      extra: {
        ...(safeJson(row.extra_json) ?? {}),
        reprocess: {
          original_request_id: row.id,
          original_error_code: row.error_code,
          requested_at: new Date().toISOString(),
        },
      },
    });
    await c.env.ANALYZE_QUEUE.send({
      request_id: requestId,
      app_id: row.app_id,
      biz_type: bizType,
      created_at_ms: Date.now(),
    });
    reprocessed.push({
      original_request_id: row.id,
      request_id: requestId,
      biz_id: row.biz_id,
      error_code: row.error_code,
    });
  }

  return c.json({
    dry_run: body.dry_run,
    selected: items.length,
    enqueued: body.dry_run ? 0 : reprocessed.length,
    skipped: skipped.length,
    next_cursor: nextCursor,
    items: reprocessed,
    skipped_items: skipped,
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

function toAnalyzeBizType(raw: string): AnalyzeBizType | null {
  return (ANALYZE_BIZ_TYPES as readonly string[]).includes(raw) ? raw as AnalyzeBizType : null;
}

function toDeliveryMode(raw: string | null): DeliveryMode | null {
  const value = raw ?? "both";
  return (DELIVERY_MODE as readonly string[]).includes(value) ? value as DeliveryMode : null;
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
