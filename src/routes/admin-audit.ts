import { Hono } from "hono";
import { z } from "zod";
import { verifyAdmin } from "../auth/hmac.ts";
import { listAdminAuditLogs } from "../db/admin-audit.ts";

export const adminAuditRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminAuditRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers); // 仅头部鉴权（?token= 仅 evidence 路由允许）
  await next();
});

const ListAuditQuery = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  target_type: z.string().min(1).optional(),
  target_id: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.coerce.number().int().positive().optional(),
});

adminAuditRouter.get("/", async (c) => {
  const q = ListAuditQuery.parse(normalizeQuery(c.req.query()));
  const { items, nextCursor } = await listAdminAuditLogs(c.env.DB, {
    actor: q.actor,
    action: q.action,
    target_type: q.target_type,
    target_id: q.target_id,
    from_ms: q.from ? Date.parse(q.from) : undefined,
    to_ms: q.to ? Date.parse(q.to) : undefined,
    limit: q.limit,
    cursor: q.cursor,
  });
  return c.json({
    items: items.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      metadata: safeJson(row.metadata_json),
      created_at: new Date(row.created_at).toISOString(),
    })),
    next_cursor: nextCursor,
  });
});

function normalizeQuery(query: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v || undefined]));
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
