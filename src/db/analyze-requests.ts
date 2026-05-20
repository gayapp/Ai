import type { AnalyzeBizType, AnalyzeRow, AnalyzeStatus, DeliveryMode } from "../analyze/types.ts";

export interface InsertAnalyzePendingArgs {
  id: string;
  app_id: string;
  biz_type: AnalyzeBizType;
  biz_id: string;
  user_id: string | null;
  input_hash: string;
  input_json: string;
  mode: string;
  delivery_mode: DeliveryMode;
  callback_url: string | null;
  extra: Record<string, unknown> | null;
}

export async function insertAnalyzePending(
  db: D1Database,
  a: InsertAnalyzePendingArgs,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analyze_requests
       (id, app_id, biz_type, biz_id, user_id, input_hash, input_json,
        mode, status, delivery_mode, callback_url, extra_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      a.id,
      a.app_id,
      a.biz_type,
      a.biz_id,
      a.user_id,
      a.input_hash,
      a.input_json,
      a.mode,
      a.delivery_mode,
      a.callback_url,
      a.extra ? JSON.stringify(a.extra) : null,
      Date.now(),
    )
    .run();
}

export async function getAnalyzeById(
  db: D1Database,
  id: string,
): Promise<AnalyzeRow | null> {
  return await db
    .prepare(`SELECT * FROM analyze_requests WHERE id = ?`)
    .bind(id)
    .first<AnalyzeRow>();
}

export interface CompleteAnalyzeArgs {
  id: string;
  cached: boolean;
  status: Exclude<AnalyzeStatus, "pending">;
  result_json: string | null;
  provider: string | null;
  model: string | null;
  prompt_version: number | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code: string | null;
}

export async function completeAnalyze(
  db: D1Database,
  a: CompleteAnalyzeArgs,
): Promise<void> {
  await db
    .prepare(
      `UPDATE analyze_requests SET
         cached = ?, status = ?, result_json = ?, provider = ?, model = ?,
         prompt_version = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?,
         error_code = ?, completed_at = ?
       WHERE id = ?`,
    )
    .bind(
      a.cached ? 1 : 0,
      a.status,
      a.result_json,
      a.provider,
      a.model,
      a.prompt_version,
      a.input_tokens,
      a.output_tokens,
      a.latency_ms,
      a.error_code,
      Date.now(),
      a.id,
    )
    .run();
}

export async function markAnalyzeDelivered(
  db: D1Database,
  id: string,
  deliveredAt: number,
): Promise<void> {
  await db
    .prepare(`UPDATE analyze_requests SET delivered_at = ? WHERE id = ?`)
    .bind(deliveredAt, id)
    .run();
}

export async function ackAnalyze(
  db: D1Database,
  id: string,
  ackedAt: number,
): Promise<AnalyzeRow | null> {
  await db
    .prepare(`UPDATE analyze_requests SET acked_at = ? WHERE id = ? AND acked_at IS NULL`)
    .bind(ackedAt, id)
    .run();
  return await getAnalyzeById(db, id);
}

export async function listAnalyzeForPull(
  db: D1Database,
  opts: {
    app_id: string;
    status: "ok" | "error";
    biz_type?: AnalyzeBizType;
    since_id?: string;
    include: "unacked" | "all";
    limit: number;
  },
): Promise<{ items: AnalyzeRow[]; next_since_id: string | null }> {
  const where: string[] = [
    "app_id = ?",
    "status = ?",
    "delivery_mode IN ('pull', 'both')",
  ];
  const vals: unknown[] = [opts.app_id, opts.status];

  if (opts.biz_type) {
    where.push("biz_type = ?");
    vals.push(opts.biz_type);
  }
  if (opts.since_id) {
    where.push("id > ?");
    vals.push(opts.since_id);
  }
  if (opts.include === "unacked") {
    where.push("acked_at IS NULL");
  }

  const limit = Math.min(Math.max(opts.limit, 1), 100);
  vals.push(limit + 1);
  const { results } = await db
    .prepare(
      `SELECT * FROM analyze_requests
       WHERE ${where.join(" AND ")}
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(...vals)
    .all<AnalyzeRow>();

  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  const next_since_id = hasMore ? (items[items.length - 1]?.id ?? null) : null;
  return { items, next_since_id };
}
