import { sendTelegramAlert } from "../alerts/telegram.ts";
import type { CallbackJob } from "./types.ts";

const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 500;

interface PendingSweepCandidate {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  mode: string;
  created_at: number;
}

export interface PendingSweepResult {
  swept: number;
  callbackEnqueued: number;
  callbackFailed: number;
  alertSent: boolean;
  ids: string[];
  oldestAgeSeconds: number;
}

export async function sweepModerationPending(
  env: Env,
  nowMs = Date.now(),
): Promise<PendingSweepResult> {
  const cutoff = nowMs - PENDING_TIMEOUT_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, app_id, biz_type, biz_id, mode, created_at
     FROM moderation_requests
     WHERE status = 'pending' AND created_at < ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(cutoff, SWEEP_LIMIT)
    .all<PendingSweepCandidate>();

  const result: PendingSweepResult = {
    swept: 0,
    callbackEnqueued: 0,
    callbackFailed: 0,
    alertSent: false,
    ids: [],
    oldestAgeSeconds: results.length > 0
      ? Math.max(0, Math.floor((nowMs - results[0]!.created_at) / 1000))
      : 0,
  };

  for (const row of results) {
    const updated = await env.DB.prepare(
      `UPDATE moderation_requests
       SET status = 'error',
           error_code = 'pending_timeout',
           reason = 'Worker 未完成（sweep）',
           completed_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(nowMs, row.id)
      .run();
    const changes = (updated.meta as { changes?: number } | undefined)?.changes ?? 0;
    if (changes <= 0) continue;

    result.swept += changes;
    result.ids.push(row.id);
    try {
      await env.CALLBACK_QUEUE.send({ request_id: row.id, attempt: 0 } satisfies CallbackJob);
      result.callbackEnqueued += 1;
    } catch (e) {
      result.callbackFailed += 1;
      console.warn("[scheduled] sweep callback enqueue failed", row.id, e);
    }
  }

  if (result.swept > 0) {
    result.alertSent = await sendSweepAlert(env, result);
  }

  return result;
}

async function sendSweepAlert(env: Env, result: PendingSweepResult): Promise<boolean> {
  const sampleIds = result.ids.slice(0, 8);
  return await sendTelegramAlert(
    env,
    {
      title: "ai-guard · moderate pending 超时",
      level: result.swept >= 5 ? "crit" : "warn",
      lines: [
        `超时请求数: ${result.swept}`,
        `阈值: pending > ${Math.round(PENDING_TIMEOUT_MS / 60000)} 分钟`,
        `最老请求年龄: ${Math.round(result.oldestAgeSeconds / 60)} 分钟`,
        `callback 补投: ${result.callbackEnqueued}`,
        `callback 入队失败: ${result.callbackFailed}`,
        ``,
        `样本 request_id:`,
        ...sampleIds.map((id) => `- ${id}`),
        result.ids.length > sampleIds.length ? `- ... plus ${result.ids.length - sampleIds.length} more` : "",
        ``,
        `后台处理: https://aicenter.1.gay/#/requests?status=error`,
        `当前 pending: https://aicenter.1.gay/#/requests?status=pending`,
      ].filter(Boolean),
      dedupKey: `moderate-pending-sweep:${Math.floor(Date.now() / 300_000)}`,
    },
    env.DEDUP_CACHE,
  );
}
