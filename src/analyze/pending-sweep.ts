import { ANALYZE_BIZ_TYPES } from "./schema/envelope.ts";
import type { AnalyzeBizType, AnalyzeJob } from "./types.ts";

export async function sweepAnalyzePending(
  env: Env,
  opts: { staleMs?: number; limit?: number } = {},
): Promise<{ scanned: number; enqueued: number; failed: number }> {
  const staleCutoff = Date.now() - (opts.staleMs ?? 5 * 60 * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await env.DB.prepare(
    `SELECT id, app_id, biz_type, created_at
     FROM analyze_requests
     WHERE status = 'pending' AND created_at < ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(staleCutoff, limit)
    .all<{ id: string; app_id: string; biz_type: string; created_at: number }>();

  let enqueued = 0;
  let failed = 0;
  for (const row of results) {
    const bizType = toAnalyzeBizType(row.biz_type);
    if (!bizType) {
      failed += 1;
      console.warn("[analyze-pending-sweep] unsupported biz_type", row.id, row.biz_type);
      continue;
    }
    try {
      await env.ANALYZE_QUEUE.send({
        request_id: row.id,
        app_id: row.app_id,
        biz_type: bizType,
        created_at_ms: row.created_at,
      } satisfies AnalyzeJob);
      enqueued += 1;
    } catch (e) {
      failed += 1;
      console.warn("[analyze-pending-sweep] enqueue failed", row.id, e);
    }
  }
  return { scanned: results.length, enqueued, failed };
}

function toAnalyzeBizType(raw: string): AnalyzeBizType | null {
  return (ANALYZE_BIZ_TYPES as readonly string[]).includes(raw) ? raw as AnalyzeBizType : null;
}
