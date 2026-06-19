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
import {
  BACKPRESSURE_HARD_LIMIT,
  BACKPRESSURE_WARN_PCT,
  PENDING_COUNT_KV_KEY,
  getBacklogSeverity,
} from "../analyze/backpressure.ts";
import {
  loadAnalyzeGrayMetricRows,
  summarizeAnalyzeBacklog,
  summarizeAnalyzeRequests,
  type AnalyzeGrayMetricRow,
} from "../db/admin-analyze-queries.ts";
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

adminStatsRouter.get("/analyze-summary", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const app_id = c.req.query("app_id") ?? undefined;
  const row = await summarizeAnalyzeRequests(c.env.DB, { app_id, from_ms, to_ms });
  return c.json({
    from: new Date(from_ms).toISOString(),
    to: new Date(to_ms).toISOString(),
    total: row.count_total,
    cached: row.count_cached,
    cache_hit_rate: row.count_total ? +(row.count_cached / row.count_total).toFixed(4) : 0,
    by_status: {
      pending: row.count_pending,
      ok: row.count_ok,
      error: row.count_error,
    },
    ok_rate: row.count_total > 0 ? +(row.count_ok / row.count_total).toFixed(4) : 0,
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
    },
    output_bytes_total: row.output_bytes_total,
  });
});

adminStatsRouter.get("/analyze-backlog", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const app_id = c.req.query("app_id") ?? undefined;
  const row = await summarizeAnalyzeBacklog(c.env.DB, {
    app_id,
    from_ms,
    to_ms,
    now_ms: Date.now(),
  });
  return c.json({
    from: new Date(from_ms).toISOString(),
    to: new Date(to_ms).toISOString(),
    app_id: app_id ?? null,
    pending: {
      total: row.pending_total,
      older_than_5m: row.pending_older_than_5m,
      older_than_30m: row.pending_older_than_30m,
      older_than_2h: row.pending_older_than_2h,
      oldest_at: row.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null,
      age_buckets: {
        lt_5m: row.pending_lt_5m,
        m5_30m: row.pending_5m_30m,
        m30_2h: row.pending_30m_2h,
        gt_2h: row.pending_gt_2h,
      },
    },
    pull_unacked: {
      total: row.pull_unacked_total,
      older_than_5m: row.pull_unacked_older_than_5m,
      older_than_30m: row.pull_unacked_older_than_30m,
      older_than_2h: row.pull_unacked_older_than_2h,
      oldest_at: row.oldest_pull_unacked_at ? new Date(row.oldest_pull_unacked_at).toISOString() : null,
      age_buckets: {
        lt_5m: row.pull_unacked_lt_5m,
        m5_30m: row.pull_unacked_5m_30m,
        m30_2h: row.pull_unacked_30m_2h,
        gt_2h: row.pull_unacked_gt_2h,
      },
    },
    callback_undelivered: {
      total: row.callback_undelivered_total,
      older_than_5m: row.callback_undelivered_older_than_5m,
      older_than_30m: row.callback_undelivered_older_than_30m,
      older_than_2h: row.callback_undelivered_older_than_2h,
      oldest_at: row.oldest_callback_undelivered_at
        ? new Date(row.oldest_callback_undelivered_at).toISOString()
        : null,
      age_buckets: {
        lt_5m: row.callback_undelivered_lt_5m,
        m5_30m: row.callback_undelivered_5m_30m,
        m30_2h: row.callback_undelivered_30m_2h,
        gt_2h: row.callback_undelivered_gt_2h,
      },
    },
  });
});

adminStatsRouter.get("/analyze-backpressure", async (c) => {
  const raw = await readPendingPoolKv(c.env);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM analyze_requests WHERE status = 'pending'`,
  ).first<{ n: number }>();
  const actualCount = Math.max(0, Number(row?.n ?? 0) || 0);
  const cachedCount = parsePendingPoolCount(raw.value);
  const warnThreshold = Math.floor(BACKPRESSURE_HARD_LIMIT * BACKPRESSURE_WARN_PCT);

  return c.json({
    generated_at: new Date().toISOString(),
    hard_limit: BACKPRESSURE_HARD_LIMIT,
    warn_threshold: warnThreshold,
    kv: {
      key: PENDING_COUNT_KV_KEY,
      state: raw.state,
      cached_count: cachedCount,
      raw_value: raw.state === "hit" ? raw.value : null,
    },
    actual: {
      pending_count: actualCount,
      severity: getBacklogSeverity(actualCount),
    },
    effective: {
      pending_count: cachedCount ?? actualCount,
      severity: getBacklogSeverity(cachedCount ?? actualCount),
      source: cachedCount === null ? "actual_fallback" : "kv",
    },
  });
});

adminStatsRouter.get("/analyze-gray", async (c) => {
  const { from_ms, to_ms } = resolveRange(c);
  const app_id = c.req.query("app_id") ?? undefined;
  const limit = clampInt(c.req.query("limit"), 10000, 1, 50000);
  const baselineP95Ms = finitePositive(c.req.query("baseline_p95_ms"));
  const rows = await loadAnalyzeGrayMetricRows(c.env.DB, { app_id, from_ms, to_ms, limit });
  const total = rows.length;
  const byStatus = countBy(rows, (r) => r.status || "unknown");
  const byBizType = countBy(rows, (r) => r.biz_type || "unknown");
  const cached = rows.filter((r) => r.cached === 1).length;
  const latency = percentiles(rows.map((r) => numberOrNull(r.latency_ms)));
  const outputTokens = percentiles(rows.map((r) => numberOrNull(r.output_tokens)));
  const inputTokens = percentiles(rows.map((r) => numberOrNull(r.input_tokens)));
  const completed = rows.filter((r) => r.status === "ok" || r.status === "error");
  const stalePendingCutoff = Date.now() - 5 * 60 * 1000;
  const stalePending = rows.filter(
    (r) => r.status === "pending" && r.created_at < stalePendingCutoff,
  ).length;
  const callbackUndelivered = completed.filter(
    (r) => (r.delivery_mode === "callback" || r.delivery_mode === "both") && !r.delivered_at,
  ).length;
  const pullUnacked = completed.filter(
    (r) => (r.delivery_mode === "pull" || r.delivery_mode === "both") && !r.acked_at,
  ).length;
  const errorCodes = countBy(
    rows.filter((r) => r.status === "error"),
    (r) => r.error_code || "unknown",
  );

  const errorRate = total ? round4((byStatus.error ?? 0) / total) : 0;
  const dedupHitRate = total ? round4(cached / total) : 0;
  const latencyRatio = baselineP95Ms && latency.p95 !== null
    ? round4(latency.p95 / baselineP95Ms)
    : null;
  const gates = {
    has_samples: total > 0,
    error_rate_under_1_percent: total > 0 && errorRate < 0.01,
    no_pending_older_than_5m: stalePending === 0,
    dedup_hit_rate_at_least_30_percent: total > 0 && dedupHitRate >= 0.3,
    latency_within_1_5x_baseline: baselineP95Ms && latency.p95 !== null
      ? latency.p95 <= baselineP95Ms * 1.5
      : false,
  };

  return c.json({
    from: new Date(from_ms).toISOString(),
    to: new Date(to_ms).toISOString(),
    app_id: app_id ?? null,
    sample_limit: limit,
    sample_size: total,
    ready_for_next_stage: Object.values(gates).every(Boolean),
    gates,
    status: {
      by_status: {
        pending: byStatus.pending ?? 0,
        ok: byStatus.ok ?? 0,
        error: byStatus.error ?? 0,
      },
      error_rate: errorRate,
      ok_rate: total ? round4((byStatus.ok ?? 0) / total) : 0,
      pending_older_than_5m: stalePending,
    },
    latency_ms: latency,
    tokens: {
      input: inputTokens,
      output: outputTokens,
    },
    baseline: {
      internal_p95_ms: baselineP95Ms,
      p95_ratio: latencyRatio,
      max_allowed_p95_ms: baselineP95Ms ? Math.round(baselineP95Ms * 1.5) : null,
    },
    dedup: {
      cached,
      hit_rate: dedupHitRate,
      expected_min_hit_rate: 0.3,
    },
    delivery: {
      callback_undelivered: callbackUndelivered,
      pull_unacked: pullUnacked,
    },
    error_codes: errorCodes,
    by_biz_type: byBizType,
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
    status: statusParam ? parseAdminModerationStatus(statusParam) : undefined,
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

async function readPendingPoolKv(env: Env): Promise<{
  state: "hit" | "miss" | "malformed" | "error";
  value: string | null;
}> {
  try {
    const raw = await env.NONCE.get(PENDING_COUNT_KV_KEY);
    if (!raw) return { state: "miss", value: null };
    return parsePendingPoolCount(raw) === null
      ? { state: "malformed", value: raw }
      : { state: "hit", value: raw };
  } catch {
    return { state: "error", value: null };
  }
}

function parsePendingPoolCount(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseAdminModerationStatus(raw: string): Status | "pending" {
  if (raw === "pending") return "pending";
  return Status.parse(raw);
}

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
    image_urls: row.image_urls ? JSON.parse(row.image_urls) : null, // post 多图查看
    labels: row.labels ? JSON.parse(row.labels) : null, // post 结构化标签
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

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function finitePositive(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentiles(values: Array<number | null>): {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
} {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[idx] ?? null;
}

function countBy(
  rows: AnalyzeGrayMetricRow[],
  pick: (row: AnalyzeGrayMetricRow) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function round4(value: number): number {
  return +value.toFixed(4);
}
