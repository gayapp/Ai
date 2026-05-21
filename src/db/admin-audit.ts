export interface AdminAuditLogInput {
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata?: Record<string, unknown>;
}

export interface AdminAuditLogRow {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string | null;
  created_at: number;
}

export interface ListAdminAuditArgs {
  actor?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  from_ms?: number;
  to_ms?: number;
  limit?: number;
  cursor?: number;
}

export function adminActorFromHeaders(headers: Headers): string {
  return headers.get("cf-access-authenticated-user-email") ||
    headers.get("x-admin-actor") ||
    "admin";
}

export async function logAdminAudit(
  db: D1Database,
  input: AdminAuditLogInput,
): Promise<void> {
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  await db
    .prepare(
      `INSERT INTO admin_audit_logs
       (actor, action, target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.actor.slice(0, 256),
      input.action.slice(0, 128),
      input.target_type.slice(0, 64),
      input.target_id.slice(0, 256),
      metadata,
      Date.now(),
    )
    .run();
}

export async function logAdminAuditBestEffort(
  db: D1Database,
  input: AdminAuditLogInput,
): Promise<void> {
  try {
    await logAdminAudit(db, input);
  } catch (e) {
    console.warn("[admin-audit] write failed", e instanceof Error ? e.message : String(e));
  }
}

export async function listAdminAuditLogs(
  db: D1Database,
  opts: ListAdminAuditArgs,
): Promise<{ items: AdminAuditLogRow[]; nextCursor: number | null }> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.actor) {
    where.push("actor = ?");
    vals.push(opts.actor);
  }
  if (opts.action) {
    where.push("action = ?");
    vals.push(opts.action);
  }
  if (opts.target_type) {
    where.push("target_type = ?");
    vals.push(opts.target_type);
  }
  if (opts.target_id) {
    where.push("target_id = ?");
    vals.push(opts.target_id);
  }
  if (opts.from_ms !== undefined) {
    where.push("created_at >= ?");
    vals.push(opts.from_ms);
  }
  if (opts.to_ms !== undefined) {
    where.push("created_at <= ?");
    vals.push(opts.to_ms);
  }
  if (opts.cursor !== undefined) {
    where.push("id < ?");
    vals.push(opts.cursor);
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  vals.push(limit + 1);
  const { results } = await db
    .prepare(
      `SELECT id, actor, action, target_type, target_id, metadata_json, created_at
       FROM admin_audit_logs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(...vals)
    .all<AdminAuditLogRow>();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  return {
    items,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}
