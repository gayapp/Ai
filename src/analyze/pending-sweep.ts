import { ANALYZE_BIZ_TYPES } from "./schema/envelope.ts";
import { completeAnalyze } from "../db/analyze-requests.ts";
import { resolveAnalyzeRoute } from "../providers/router.ts";
import type { ProviderStrategy } from "../moderation/types.ts";
import type { AnalyzeBizType, AnalyzeJob } from "./types.ts";

/**
 * 兜底扫描 pending analyze 请求。两段处理（M9）：
 *  1. 超过 giveUpMs 还卡在 pending 的 → 标 error(pending_timeout) + 发终态 callback，
 *     退出 pending 池（防止 provider 长时间 down 时 pending 无界增长 + 无限重投）。
 *  2. staleMs ~ giveUpMs 之间的 → 重新入队重试。
 * 两段都各自 LIMIT，避免一次性生成上万条 callback。
 */
export async function sweepAnalyzePending(
  env: Env,
  opts: { staleMs?: number; giveUpMs?: number; limit?: number } = {},
): Promise<{ scanned: number; enqueued: number; failed: number; expired: number }> {
  const now = Date.now();
  const staleCutoff = now - (opts.staleMs ?? 5 * 60 * 1000);
  const giveUpCutoff = now - (opts.giveUpMs ?? 2 * 60 * 60 * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  let enqueued = 0;
  let failed = 0;
  let expired = 0;

  // 1) 超龄放弃：pending 存活超过 giveUpMs → 终态 error + callback，退出 pending 池
  // M25: JOIN apps 拿 provider_strategy → 回填 intended_provider，避免 stats_rollup 的
  //   `unknown` 桶被 sweep give-up 污染。app 不存在或 biz_type 不识别时退回 null。
  const { results: giveUpRows } = await env.DB.prepare(
    `SELECT r.id, r.biz_type, r.delivery_mode, a.provider_strategy
     FROM analyze_requests r
     LEFT JOIN apps a ON a.id = r.app_id
     WHERE r.status = 'pending' AND r.created_at < ?
     ORDER BY r.created_at ASC
     LIMIT ?`,
  )
    .bind(giveUpCutoff, limit)
    .all<{ id: string; biz_type: string; delivery_mode: string; provider_strategy: string | null }>();

  for (const row of giveUpRows) {
    try {
      const intendedProvider = resolveIntendedProvider(row.biz_type, row.provider_strategy);
      await completeAnalyze(env.DB, {
        id: row.id,
        cached: false,
        status: "error",
        result_json: null,
        provider: intendedProvider,
        model: null,
        prompt_version: null,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: "pending_timeout",
      });
      if (row.delivery_mode === "callback" || row.delivery_mode === "both") {
        await env.CALLBACK_QUEUE.send({ request_id: row.id, attempt: 0 });
      }
      expired += 1;
    } catch (e) {
      failed += 1;
      console.warn("[analyze-pending-sweep] give-up failed", row.id, e);
    }
  }

  // 2) 重试窗口：staleMs ~ giveUpMs 之间的 pending → 重新入队
  const { results } = await env.DB.prepare(
    `SELECT id, app_id, biz_type, created_at
     FROM analyze_requests
     WHERE status = 'pending' AND created_at < ? AND created_at >= ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(staleCutoff, giveUpCutoff, limit)
    .all<{ id: string; app_id: string; biz_type: string; created_at: number }>();

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
  return { scanned: results.length + giveUpRows.length, enqueued, failed, expired };
}

function toAnalyzeBizType(raw: string): AnalyzeBizType | null {
  return (ANALYZE_BIZ_TYPES as readonly string[]).includes(raw) ? raw as AnalyzeBizType : null;
}

/**
 * 回填 sweep give-up 的 intended_provider（M25）：从 biz_type + app.provider_strategy 解出
 * 当时本应该走的 primary provider；解不出（biz_type 未知 / app 已删）则返回 null。
 */
function resolveIntendedProvider(rawBiz: string, rawStrategy: string | null): string | null {
  const biz = toAnalyzeBizType(rawBiz);
  if (!biz) return null;
  const strategy = (rawStrategy ?? "auto") as ProviderStrategy;
  return resolveAnalyzeRoute(biz, strategy).primary;
}
