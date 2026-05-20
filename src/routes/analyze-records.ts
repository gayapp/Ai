import { Hono } from "hono";
import { z } from "zod";
import { verifyAppRequest } from "../auth/hmac.ts";
import type { AnalyzeBizType, AnalyzeRow } from "../analyze/types.ts";
import { ANALYZE_BIZ_TYPES } from "../analyze/schema/envelope.ts";
import { ackAnalyze, getAnalyzeById, listAnalyzeForPull } from "../db/analyze-requests.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";

export const analyzeRecordsRouter = new Hono<{ Bindings: Env }>();

analyzeRecordsRouter.get("/v1/analyze", async (c) => {
  const app = await verifyAppRequest(c.env, c.req.raw.headers, "");
  const parsed = parseListQuery(c.req.query());
  const page = await listAnalyzeForPull(c.env.DB, {
    app_id: app.id,
    status: parsed.status,
    biz_type: parsed.biz_type,
    since_id: parsed.since_id,
    include: parsed.include,
    limit: parsed.limit,
  });
  return c.json({
    items: page.items.map(formatAnalyzeRow),
    next_since_id: page.next_since_id,
  });
});

analyzeRecordsRouter.get("/v1/analyze/:id", async (c) => {
  const app = await verifyAppRequest(c.env, c.req.raw.headers, "");
  const row = await getAnalyzeById(c.env.DB, c.req.param("id"));
  if (!row || row.app_id !== app.id) {
    throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  }
  return c.json(formatAnalyzeRow(row));
});

analyzeRecordsRouter.post("/v1/analyze/:id/ack", async (c) => {
  const rawBody = await c.req.text();
  const app = await verifyAppRequest(c.env, c.req.raw.headers, rawBody);
  const id = c.req.param("id");
  const row = await getAnalyzeById(c.env.DB, id);
  if (!row || row.app_id !== app.id) {
    throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  }
  if (row.delivery_mode === "callback") {
    throw new AppError(
      ErrorCodes.CONFLICT,
      409,
      "callback-only analyze request cannot be acked",
    );
  }
  const ackedAt = row.acked_at ?? Date.now();
  const updated = row.acked_at ? row : await ackAnalyze(c.env.DB, id, ackedAt);
  if (!updated) throw new AppError(ErrorCodes.NOT_FOUND, 404, "request not found");
  return c.json({
    request_id: id,
    acked_at: new Date(updated.acked_at ?? ackedAt).toISOString(),
  });
});

const ListQuerySchema = z.object({
  status: z.enum(["ok", "error"]),
  biz_type: z.enum(ANALYZE_BIZ_TYPES).optional(),
  since_id: z.string().min(1).optional(),
  include: z.enum(["unacked", "all"]).default("unacked"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function parseListQuery(query: Record<string, string>): {
  status: "ok" | "error";
  biz_type?: AnalyzeBizType;
  since_id?: string;
  include: "unacked" | "all";
  limit: number;
} {
  try {
    const normalized = {
      ...query,
      since_id: query.since_id || undefined,
    };
    return ListQuerySchema.parse(normalized);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, msg);
  }
}

function formatAnalyzeRow(row: AnalyzeRow): Record<string, unknown> {
  const result = safeJson(row.result_json);
  return {
    request_id: row.id,
    status: row.status,
    biz_type: row.biz_type,
    biz_id: row.biz_id,
    ...(result ? { result } : {}),
    provider: row.provider,
    model: row.model,
    cached: !!row.cached,
    tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
    latency_ms: row.latency_ms ?? 0,
    error_code: row.error_code,
    delivery_mode: row.delivery_mode,
    delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
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
