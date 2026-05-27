/**
 * Provider 健康 / 凭证状态检查 + 即时告警
 *
 * 两条路径：
 *  1. 实时反应：pipeline 捕获 401/403 时 → alertProviderAuthFailed()
 *     → 立刻 Telegram crit + （可选）邮件
 *  2. 主动巡检（Cron 每 5 min）：checkProviderHealth() 调 xAI /v1/api-key
 *     → 发现 blocked / disabled → 告警；team_blocked 单独走 crit + console 链接
 *
 * Gemini 没有类似的 key-status 公开端点；只能靠路径 1 反应式。
 */

import type { Provider } from "../moderation/schema.ts";
import { sendTelegramAlert } from "./telegram.ts";
import { sendAlertEmail } from "./email.ts";
import { createGeminiAdapter } from "../providers/gemini.ts";

const AUTH_ALERT_DEDUP_TTL = 10 * 60; // 10 分钟内同 provider 不重复发
const RECUR_WINDOW_SECONDS = 24 * 60 * 60; // 24h 复发计数窗
const RECUR_COUNT_KEY_PREFIX = "recur-count:";

// ============================================================
// 24h 复发计数 (M12)
// ============================================================
// 同一根因（provider+reason）24h 内第二次出现就升级告警标题为「复发」。
// 用 DEDUP_CACHE 单 KV key 模拟计数器：get → parse → put，KV 一致性窗内可能
// 偶尔少 1 次，但「>=2」语义稳定。
async function bumpRecurrence(
  kv: KVNamespace,
  provider: string,
  reason: string,
): Promise<number> {
  const k = `${RECUR_COUNT_KEY_PREFIX}${provider}:${reason}`;
  const raw = await kv.get(k);
  const prev = raw ? parseInt(raw, 10) : 0;
  const next = (Number.isFinite(prev) ? prev : 0) + 1;
  await kv.put(k, String(next), { expirationTtl: RECUR_WINDOW_SECONDS });
  return next;
}

// ============================================================
// 实时告警（401/403 被捕获时）
// ============================================================

export async function alertProviderAuthFailed(
  env: Env,
  provider: Provider,
  message: string,
  details?: unknown,
): Promise<void> {
  const detailStr = typeof details === "string" ? details : JSON.stringify(details ?? "");

  // M12: 24h 内复发计数
  const recurCount = await bumpRecurrence(env.DEDUP_CACHE, provider, "auth_failed");
  const isRecur = recurCount >= 2;

  const titlePrefix = isRecur
    ? `⚠️⚠️ 复发 (24h 内 ${recurCount} 次)`
    : "🚨 ai-guard";
  const lines = [
    `Provider: ${provider}`,
    `错误: ${message}`,
    `上游返回: ${(detailStr || "无").slice(0, 200)}`,
    ``,
    `影响: 熔断已打开 10 分钟，后续请求自动切备援 provider`,
    `如备援也同样失败，用户侧将收到 503 service_unavailable`,
    ``,
    `紧急处置:`,
    `  1. xAI / Google 控制台确认 key 是否被 disable 或余额用完`,
    `  2. wrangler secret put ${provider === "grok" ? "GROK_API_KEY" : "GEMINI_API_KEY"} 更新 key`,
  ];
  if (isRecur) {
    lines.push(``, `⚠️ 24h 内已第 ${recurCount} 次：根因可能在账号侧（账单/风控），请优先排查。`);
  }

  const dedupKey = `provider-auth:${provider}`;
  const tgOk = await sendTelegramAlert(
    env,
    {
      title: `${titlePrefix} · ${provider.toUpperCase()} 凭证失效`,
      level: "crit",
      lines,
      dedupKey,
    },
    env.DEDUP_CACHE,
  );

  // 同时发邮件（如果配置）— dedup 走 KV
  const emailDedupKey = `email-${dedupKey}`;
  const seen = await env.DEDUP_CACHE.get(emailDedupKey);
  if (!seen) {
    await env.DEDUP_CACHE.put(emailDedupKey, "1", { expirationTtl: AUTH_ALERT_DEDUP_TTL });
    const emailOk = await sendAlertEmail(env, {
      subject: `[ai-guard] ${provider.toUpperCase()} API 凭证失效 - 需立即处置`,
      text: [`ai-guard 检测到 ${provider} 凭证失效`, ``, ...lines].join("\n"),
    });
    console.log(`[alert] auth-failed notify: tg=${tgOk} email=${emailOk}`);
  }
}

// ============================================================
// 主动巡检（Cron 调用）
// ============================================================

interface XaiKeyStatus {
  api_key_blocked: boolean;
  api_key_disabled: boolean;
  team_blocked: boolean;
  redacted_api_key?: string;
}

/** xAI 健康检查的归类原因 —— 用于 dedupKey / 告警分级（M11） */
export type XaiHealthReason =
  | "team_blocked"
  | "api_key_blocked"
  | "api_key_disabled"
  | "unauthorized"
  | "http_error"
  | "network_error"
  | "not_configured";

/** 查 xAI key 状态；异常或 blocked/disabled 即告警 */
async function checkXai(env: Env): Promise<{
  ok: boolean;
  reason?: XaiHealthReason;
  detail?: string;
  raw?: unknown;
}> {
  const key = env.GROK_API_KEY;
  if (!key) return { ok: false, reason: "not_configured", detail: "GROK_API_KEY not set" };

  try {
    const res = await fetch("https://api.x.ai/v1/api-key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "unauthorized", detail: `key unauthorized (http ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, reason: "http_error", detail: `http ${res.status}` };
    }
    const data = (await res.json()) as XaiKeyStatus;
    if (data.team_blocked) return { ok: false, reason: "team_blocked", raw: data };
    if (data.api_key_blocked) return { ok: false, reason: "api_key_blocked", raw: data };
    if (data.api_key_disabled) return { ok: false, reason: "api_key_disabled", raw: data };
    return { ok: true, raw: data };
  } catch (e) {
    return {
      ok: false,
      reason: "network_error",
      detail: `check request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Gemini 无公开 key-status 端点；只能用轻探（一个最小 prompt）。
 *  为避免巡检都在烧 Token，这里只做"存在性"校验 — 向 API 发一个带 key 的 HEAD，
 *  根据返回判断 key 是否有效。 */
async function checkGemini(env: Env): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, reason: "GEMINI_API_KEY not set" };

  try {
    await createGeminiAdapter(env).moderate({
      systemPrompt: "Return a valid moderation JSON object for this health check.",
      content: "health check",
      isImage: false,
      timeoutMs: 8000,
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface HealthReport {
  grok: { ok: boolean; reason?: XaiHealthReason; detail?: string; raw?: unknown };
  gemini: { ok: boolean; reason?: string };
  fired: string[];
}

/** 所有 provider 健康检查 + 出问题即发告警 */
export async function checkProviderHealth(env: Env): Promise<HealthReport> {
  const [grok, gemini] = await Promise.all([checkXai(env), checkGemini(env)]);
  const fired: string[] = [];

  if (!grok.ok && grok.reason) {
    const tgOk = await sendGrokHealthAlert(env, grok.reason, grok.detail, grok.raw);
    if (tgOk) fired.push(`grok:${grok.reason}`);
  }
  if (!gemini.ok) {
    const tgOk = await sendTelegramAlert(
      env,
      {
        title: "⚠️ ai-guard · Gemini 凭证异常",
        level: "crit",
        lines: [
          `状态: ${gemini.reason}`,
          ``,
          `到 https://aistudio.google.com/app/apikey 查看，或 wrangler secret put GEMINI_API_KEY`,
        ],
        dedupKey: `health:gemini:${gemini.reason}`,
        dedupTtlSeconds: 600,
      },
      env.DEDUP_CACHE,
    );
    if (tgOk) fired.push("gemini");
  }

  return { grok, gemini, fired };
}

/**
 * 把 xAI 健康检查每种 reason 映射到独立的 Telegram 告警载荷（M11）。
 *  - team_blocked 是组织级屏蔽 → 标题加 🚨🚨、写明 console 链接，最严重
 *  - api_key_blocked / api_key_disabled → crit，key 级失效
 *  - unauthorized → crit，401/403
 *  - http_error / network_error → warn，可能是上游抖动或自身网络
 *
 *  dedupTtl 统一 600s：配合 5min cron，状态不变时 10min 内不刷屏，状态变更后能快速复报。
 *  M12：同 reason 24h 内复发 ≥2 次 → 标题加「复发 (24h 内 N 次)」、强制 crit。
 */
async function sendGrokHealthAlert(
  env: Env,
  reason: XaiHealthReason,
  detail: string | undefined,
  raw: unknown,
): Promise<boolean> {
  const rawStr = JSON.stringify(raw ?? "").slice(0, 200);
  const recurCount = await bumpRecurrence(env.DEDUP_CACHE, "grok", reason);
  const isRecur = recurCount >= 2;
  const recurNote = isRecur
    ? `⚠️ 24h 内已第 ${recurCount} 次：根因可能在账号侧（账单/风控/合规），请优先排查。`
    : null;

  let title: string;
  let level: "crit" | "warn";
  let lines: string[];

  switch (reason) {
    case "team_blocked":
      title = "🚨🚨 ai-guard · Grok team_blocked（组织级屏蔽）";
      level = "crit";
      lines = [
        `状态: team_blocked = true（整个 xAI 组织被屏蔽，所有 key 失效）`,
        `详情: ${rawStr}`,
        ``,
        `立刻处置:`,
        `  1. 访问 https://console.x.ai/ 查账单 / 风控 / ToS 状态`,
        `  2. 联系 xAI 支持确认屏蔽原因`,
        `  3. 期间 ai-guard 自动切 Gemini 备援，但 NSFW comment 可能触发 gemini 安全过滤`,
      ];
      break;
    case "api_key_blocked":
      title = "🚨 ai-guard · Grok api_key_blocked";
      level = "crit";
      lines = [
        `状态: api_key_blocked = true（单 key 被屏蔽）`,
        `详情: ${rawStr}`,
        ``,
        `处置: https://console.x.ai/ 查 key 状态，或 wrangler secret put GROK_API_KEY 换新 key`,
      ];
      break;
    case "api_key_disabled":
      title = "🚨 ai-guard · Grok api_key_disabled";
      level = "crit";
      lines = [
        `状态: api_key_disabled = true（key 已被禁用）`,
        `详情: ${rawStr}`,
        ``,
        `处置: https://console.x.ai/ 重新启用或换 key，wrangler secret put GROK_API_KEY`,
      ];
      break;
    case "unauthorized":
      title = "🚨 ai-guard · Grok 401/403";
      level = "crit";
      lines = [
        `状态: ${detail ?? "401/403"}`,
        ``,
        `处置: 检查 key 是否正确 / 余额，或 wrangler secret put GROK_API_KEY`,
      ];
      break;
    case "http_error":
      title = "⚠️ ai-guard · Grok health endpoint 返非 2xx";
      level = "warn";
      lines = [
        `状态: ${detail ?? "http error"}`,
        ``,
        `可能是上游抖动；若持续 >10 min 请到 https://console.x.ai/ 排查`,
      ];
      break;
    case "network_error":
      title = "⚠️ ai-guard · Grok health 巡检请求失败";
      level = "warn";
      lines = [
        `状态: ${detail ?? "network error"}`,
        ``,
        `多为网络抖动；若反复出现，确认 xAI status 页`,
      ];
      break;
    case "not_configured":
      title = "⚠️ ai-guard · Grok GROK_API_KEY 未配置";
      level = "warn";
      lines = [
        `状态: ${detail ?? "GROK_API_KEY not set"}`,
        ``,
        `wrangler secret put GROK_API_KEY 后重新 deploy`,
      ];
      break;
  }

  if (isRecur) {
    title = `⚠️⚠️ 复发 (24h 内 ${recurCount} 次) · ${title}`;
    level = "crit";
    if (recurNote) lines.push(``, recurNote);
  }

  return sendTelegramAlert(
    env,
    {
      title,
      level,
      lines,
      dedupKey: `health:grok:${reason}`,
      dedupTtlSeconds: 600,
    },
    env.DEDUP_CACHE,
  );
}
