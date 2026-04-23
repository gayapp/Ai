import type { AppConfig } from "../moderation/types.ts";
import type { BizType, Provider, Status } from "../moderation/schema.ts";

// =============================================================
// apps
// =============================================================

export interface AppRow {
  id: string;
  name: string;
  secret: string;
  callback_url: string | null;
  biz_types: string;
  rate_limit_qps: number;
  disabled: number;
  created_at: number;
}

export async function insertApp(db: D1Database, a: AppConfig): Promise<void> {
  await db
    .prepare(
      `INSERT INTO apps (id, name, secret, callback_url, biz_types, rate_limit_qps, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      a.id,
      a.name,
      a.secret,
      a.callback_url,
      JSON.stringify(a.biz_types),
      a.rate_limit_qps,
      a.disabled ? 1 : 0,
      Date.now(),
    )
    .run();
}

export async function getAppById(db: D1Database, id: string): Promise<AppConfig | null> {
  const row = await db.prepare(`SELECT * FROM apps WHERE id = ?`).bind(id).first<AppRow>();
  return row ? rowToAppConfig(row) : null;
}

export async function listApps(db: D1Database): Promise<AppConfig[]> {
  const { results } = await db
    .prepare(`SELECT * FROM apps ORDER BY created_at DESC`)
    .all<AppRow>();
  return results.map(rowToAppConfig);
}

export async function updateAppSecret(db: D1Database, id: string, secret: string): Promise<void> {
  await db.prepare(`UPDATE apps SET secret = ? WHERE id = ?`).bind(secret, id).run();
}

export async function updateAppFields(
  db: D1Database,
  id: string,
  fields: Partial<Pick<AppConfig, "name" | "callback_url" | "biz_types" | "rate_limit_qps" | "disabled">>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.callback_url !== undefined) {
    sets.push("callback_url = ?");
    vals.push(fields.callback_url);
  }
  if (fields.biz_types !== undefined) {
    sets.push("biz_types = ?");
    vals.push(JSON.stringify(fields.biz_types));
  }
  if (fields.rate_limit_qps !== undefined) {
    sets.push("rate_limit_qps = ?");
    vals.push(fields.rate_limit_qps);
  }
  if (fields.disabled !== undefined) {
    sets.push("disabled = ?");
    vals.push(fields.disabled ? 1 : 0);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await db.prepare(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

function rowToAppConfig(r: AppRow): AppConfig {
  return {
    id: r.id,
    name: r.name,
    secret: r.secret,
    callback_url: r.callback_url,
    biz_types: JSON.parse(r.biz_types) as string[],
    rate_limit_qps: r.rate_limit_qps,
    disabled: !!r.disabled,
  };
}

// =============================================================
// prompts
// =============================================================

export interface PromptRow {
  id: number;
  biz_type: string;
  provider: string;
  version: number;
  content: string;
  is_active: number;
  created_by: string | null;
  created_at: number;
}

export async function getActivePrompt(
  db: D1Database,
  bizType: BizType,
  provider: Provider,
): Promise<{ version: number; content: string } | null> {
  const row = await db
    .prepare(
      `SELECT version, content FROM prompts WHERE biz_type = ? AND provider = ? AND is_active = 1 LIMIT 1`,
    )
    .bind(bizType, provider)
    .first<{ version: number; content: string }>();
  return row ?? null;
}

export async function listPromptsFor(
  db: D1Database,
  bizType: BizType,
  provider: Provider,
): Promise<PromptRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM prompts WHERE biz_type = ? AND provider = ? ORDER BY version DESC`,
    )
    .bind(bizType, provider)
    .all<PromptRow>();
  return results;
}

export async function getPromptById(db: D1Database, id: number): Promise<PromptRow | null> {
  const row = await db.prepare(`SELECT * FROM prompts WHERE id = ?`).bind(id).first<PromptRow>();
  return row ?? null;
}

export async function publishPrompt(
  db: D1Database,
  bizType: BizType,
  provider: Provider,
  content: string,
  createdBy: string,
): Promise<PromptRow> {
  // Next version
  const max = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE biz_type = ? AND provider = ?`)
    .bind(bizType, provider)
    .first<{ v: number }>();
  const nextVersion = (max?.v ?? 0) + 1;
  const now = Date.now();

  await db.batch([
    db
      .prepare(`UPDATE prompts SET is_active = 0 WHERE biz_type = ? AND provider = ?`)
      .bind(bizType, provider),
    db
      .prepare(
        `INSERT INTO prompts (biz_type, provider, version, content, is_active, created_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(bizType, provider, nextVersion, content, createdBy, now),
  ]);

  const inserted = await db
    .prepare(
      `SELECT * FROM prompts WHERE biz_type = ? AND provider = ? AND version = ? LIMIT 1`,
    )
    .bind(bizType, provider, nextVersion)
    .first<PromptRow>();
  if (!inserted) throw new Error("publishPrompt: insert returned no row");
  return inserted;
}

export async function rollbackPrompt(db: D1Database, id: number): Promise<PromptRow | null> {
  const target = await getPromptById(db, id);
  if (!target) return null;
  await db.batch([
    db
      .prepare(`UPDATE prompts SET is_active = 0 WHERE biz_type = ? AND provider = ?`)
      .bind(target.biz_type, target.provider),
    db.prepare(`UPDATE prompts SET is_active = 1 WHERE id = ?`).bind(id),
  ]);
  return await getPromptById(db, id);
}

// =============================================================
// moderation_requests
// =============================================================

export interface ModerationRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  content_hash: string;
  content_text: string | null;
  evidence_key: string | null;
  prompt_version: number | null;
  provider: string | null;
  model: string | null;
  mode: string;
  cached: number;
  status: string;
  risk_level: string | null;
  categories: string | null;
  reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  error_code: string | null;
  extra: string | null;
  callback_url: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface RecordPendingArgs {
  id: string;
  app_id: string;
  biz_type: BizType;
  biz_id: string;
  user_id: string | null;
  content_hash: string;
  content_text: string;
  mode: string;
  extra: Record<string, unknown> | null;
  callback_url: string | null;
}

export async function recordPending(db: D1Database, a: RecordPendingArgs): Promise<void> {
  await db
    .prepare(
      `INSERT INTO moderation_requests
       (id, app_id, biz_type, biz_id, user_id, content_hash, content_text, mode, status, extra, callback_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(
      a.id,
      a.app_id,
      a.biz_type,
      a.biz_id,
      a.user_id,
      a.content_hash,
      a.content_text,
      a.mode,
      a.extra ? JSON.stringify(a.extra) : null,
      a.callback_url,
      Date.now(),
    )
    .run();
}

export async function setEvidenceKey(db: D1Database, id: string, key: string): Promise<void> {
  await db.prepare(`UPDATE moderation_requests SET evidence_key = ? WHERE id = ?`).bind(key, id).run();
}

export interface RecordCompletedArgs {
  id: string;
  cached: boolean;
  status: Status;
  risk_level: string | null;
  categories: string[];
  reason: string;
  provider: string | null;
  model: string | null;
  prompt_version: number | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code: string | null;
}

export async function recordCompleted(db: D1Database, a: RecordCompletedArgs): Promise<void> {
  await db
    .prepare(
      `UPDATE moderation_requests SET
         cached = ?, status = ?, risk_level = ?, categories = ?, reason = ?,
         provider = ?, model = ?, prompt_version = ?,
         input_tokens = ?, output_tokens = ?, latency_ms = ?,
         error_code = ?, completed_at = ?
       WHERE id = ?`,
    )
    .bind(
      a.cached ? 1 : 0,
      a.status,
      a.risk_level,
      JSON.stringify(a.categories),
      a.reason,
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

export async function getModerationById(
  db: D1Database,
  id: string,
): Promise<ModerationRow | null> {
  return await db
    .prepare(`SELECT * FROM moderation_requests WHERE id = ?`)
    .bind(id)
    .first<ModerationRow>();
}

export async function listModeration(
  db: D1Database,
  opts: {
    app_id?: string;
    biz_type?: BizType;
    status?: Status;
    from_ms?: number;
    to_ms?: number;
    limit?: number;
    cursor?: string;   // id from previous page's last row (UUIDv7 - time-sortable)
  },
): Promise<{ items: ModerationRow[]; nextCursor: string | null }> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }
  if (opts.biz_type) {
    where.push("biz_type = ?");
    vals.push(opts.biz_type);
  }
  if (opts.status) {
    where.push("status = ?");
    vals.push(opts.status);
  }
  if (opts.from_ms !== undefined) {
    where.push("created_at >= ?");
    vals.push(opts.from_ms);
  }
  if (opts.to_ms !== undefined) {
    where.push("created_at <= ?");
    vals.push(opts.to_ms);
  }
  // Cursor uses id for stable pagination (UUIDv7 is time-sortable).
  if (opts.cursor) {
    where.push("id < ?");
    vals.push(opts.cursor);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const sql =
    `SELECT * FROM moderation_requests` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY id DESC LIMIT ?`;
  vals.push(limit + 1); // fetch one extra to know if more exists
  const { results } = await db
    .prepare(sql)
    .bind(...vals)
    .all<ModerationRow>();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

// =============================================================
// callback_deliveries
// =============================================================

export async function upsertCallbackDelivery(
  db: D1Database,
  request_id: string,
  url: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO callback_deliveries (request_id, url, attempts, created_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(request_id) DO UPDATE SET url = excluded.url`,
    )
    .bind(request_id, url, Date.now())
    .run();
}

export async function recordCallbackResult(
  db: D1Database,
  request_id: string,
  args: { status_code: number | null; attempts: number; last_error: string | null; delivered_at: number | null; next_retry_at: number | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE callback_deliveries
       SET status_code = ?, attempts = ?, last_error = ?, delivered_at = ?, next_retry_at = ?
       WHERE request_id = ?`,
    )
    .bind(
      args.status_code,
      args.attempts,
      args.last_error,
      args.delivered_at,
      args.next_retry_at,
      request_id,
    )
    .run();
}

// =============================================================
// stats — direct, unaggregated summary (MVP; swap to rollup later)
// =============================================================

export interface SummaryRow {
  count_total: number;
  count_cached: number;
  count_pass: number;
  count_reject: number;
  count_review: number;
  count_error: number;
  input_tokens: number;
  output_tokens: number;
}

export async function summarize(
  db: D1Database,
  opts: { app_id?: string; from_ms: number; to_ms: number },
): Promise<SummaryRow> {
  const where: string[] = ["created_at >= ?", "created_at <= ?"];
  const vals: unknown[] = [opts.from_ms, opts.to_ms];
  if (opts.app_id) {
    where.push("app_id = ?");
    vals.push(opts.app_id);
  }
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS count_total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS count_cached,
         SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS count_pass,
         SUM(CASE WHEN status = 'reject' THEN 1 ELSE 0 END) AS count_reject,
         SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS count_review,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS count_error,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM moderation_requests
       WHERE ${where.join(" AND ")}`,
    )
    .bind(...vals)
    .first<SummaryRow>();
  return (
    row ?? {
      count_total: 0,
      count_cached: 0,
      count_pass: 0,
      count_reject: 0,
      count_review: 0,
      count_error: 0,
      input_tokens: 0,
      output_tokens: 0,
    }
  );
}

export async function topUsers(
  db: D1Database,
  opts: { app_id: string; from_ms: number; to_ms: number; limit?: number },
): Promise<Array<{ user_id: string; rejects: number }>> {
  const { results } = await db
    .prepare(
      `SELECT user_id, COUNT(*) AS rejects FROM moderation_requests
       WHERE app_id = ? AND status = 'reject' AND user_id IS NOT NULL
         AND created_at >= ? AND created_at <= ?
       GROUP BY user_id ORDER BY rejects DESC LIMIT ?`,
    )
    .bind(opts.app_id, opts.from_ms, opts.to_ms, opts.limit ?? 20)
    .all<{ user_id: string; rejects: number }>();
  return results;
}

// =============================================================
// app loading helper with KV cache
// =============================================================

const APP_KV_TTL = 300;

export async function loadAppCached(env: Env, app_id: string): Promise<AppConfig | null> {
  const key = `app:${app_id}`;
  const cached = await env.APPS.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as AppConfig;
    } catch {
      // fall through and reload
    }
  }
  const row = await getAppById(env.DB, app_id);
  if (row) {
    await env.APPS.put(key, JSON.stringify(row), { expirationTtl: APP_KV_TTL });
  }
  return row;
}

export async function invalidateAppCache(env: Env, app_id: string): Promise<void> {
  await env.APPS.delete(`app:${app_id}`);
}

// =============================================================
// active prompt with KV cache
// =============================================================

const PROMPT_KV_TTL = 60;

export async function loadActivePromptCached(
  env: Env,
  bizType: BizType,
  provider: Provider,
): Promise<{ version: number; content: string } | null> {
  const key = `${bizType}:${provider}:active`;
  const cached = await env.PROMPTS.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as { version: number; content: string };
    } catch {
      // fall through
    }
  }
  const row = await getActivePrompt(env.DB, bizType, provider);
  if (row) {
    await env.PROMPTS.put(key, JSON.stringify(row), { expirationTtl: PROMPT_KV_TTL });
  }
  return row;
}

export async function invalidateAllPromptCache(env: Env): Promise<void> {
  const list = await env.PROMPTS.list();
  await Promise.all(list.keys.map((k) => env.PROMPTS.delete(k.name)));
}

export async function invalidatePromptCache(
  env: Env,
  bizType: BizType,
  provider: Provider,
): Promise<void> {
  await env.PROMPTS.delete(`${bizType}:${provider}:active`);
}
