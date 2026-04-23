/**
 * Provider 健康 / 凭证状态检查 + 即时告警
 *
 * 两条路径：
 *  1. 实时反应：pipeline 捕获 401/403 时 → alertProviderAuthFailed()
 *     → 立刻 Telegram crit + （可选）邮件
 *  2. 主动巡检（Cron 每小时）：checkProviderHealth() 调 xAI /v1/api-key
 *     → 发现 blocked / disabled → 告警
 *
 * Gemini 没有类似的 key-status 公开端点；只能靠路径 1 反应式。
 */

import type { Provider } from "../moderation/schema.ts";
import { sendTelegramAlert } from "./telegram.ts";
import { sendAlertEmail } from "./email.ts";

const AUTH_ALERT_DEDUP_TTL = 10 * 60; // 10 分钟内同 provider 不重复发

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

  const dedupKey = `provider-auth:${provider}`;
  const tgOk = await sendTelegramAlert(
    env,
    {
      title: `🚨 ai-guard · ${provider.toUpperCase()} 凭证失效`,
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

/** 查 xAI key 状态；异常或 blocked/disabled 即告警 */
async function checkXai(env: Env): Promise<{
  ok: boolean;
  reason?: string;
  raw?: unknown;
}> {
  const key = env.GROK_API_KEY;
  if (!key) return { ok: false, reason: "GROK_API_KEY not set" };

  try {
    const res = await fetch("https://api.x.ai/v1/api-key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `key unauthorized (http ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, reason: `http ${res.status}` };
    }
    const data = (await res.json()) as XaiKeyStatus;
    if (data.api_key_blocked) return { ok: false, reason: "api_key_blocked", raw: data };
    if (data.api_key_disabled) return { ok: false, reason: "api_key_disabled", raw: data };
    if (data.team_blocked) return { ok: false, reason: "team_blocked", raw: data };
    return { ok: true, raw: data };
  } catch (e) {
    return {
      ok: false,
      reason: `check request failed: ${e instanceof Error ? e.message : String(e)}`,
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
    // 发一个最小的 prompt（约 10 token），response_format 强制 JSON 只让它回 "{}"
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${
      env.GEMINI_MODEL || "gemini-2.5-flash"
    }:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4 },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `key unauthorized (http ${res.status})` };
    }
    const text = await res.text();
    if (
      res.status === 400 &&
      /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(text)
    ) {
      return { ok: false, reason: "API_KEY_INVALID" };
    }
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `check request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface HealthReport {
  grok: { ok: boolean; reason?: string; raw?: unknown };
  gemini: { ok: boolean; reason?: string };
  fired: string[];
}

/** 所有 provider 健康检查 + 出问题即发告警 */
export async function checkProviderHealth(env: Env): Promise<HealthReport> {
  const [grok, gemini] = await Promise.all([checkXai(env), checkGemini(env)]);
  const fired: string[] = [];

  if (!grok.ok) {
    const tgOk = await sendTelegramAlert(
      env,
      {
        title: "⚠️ ai-guard · Grok 凭证异常",
        level: "crit",
        lines: [
          `状态: ${grok.reason}`,
          `详情: ${JSON.stringify(grok.raw ?? "").slice(0, 150)}`,
          ``,
          `立即到 https://console.x.ai/ 查看 key，或 wrangler secret put GROK_API_KEY`,
        ],
        dedupKey: `health:grok:${grok.reason}`,
      },
      env.DEDUP_CACHE,
    );
    if (tgOk) fired.push("grok");
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
      },
      env.DEDUP_CACHE,
    );
    if (tgOk) fired.push("gemini");
  }

  return { grok, gemini, fired };
}
