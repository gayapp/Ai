import { AppError, ErrorCodes } from "../lib/errors.ts";
import { loadActivePromptCached } from "../db/queries.ts";
import {
  ModelOutput,
  type BizType,
  type ExecutionResult,
  type Provider,
} from "./schema.ts";
import type { ProviderStrategy } from "./types.ts";
import { getAdapter, resolveRoute } from "../providers/router.ts";
import { canTry, recordAuthFailure, recordFailure, recordSuccess } from "../providers/circuit.ts";
import { alertProviderAuthFailed } from "../alerts/provider-health.ts";

export interface ExecuteArgs {
  bizType: BizType;
  content: string;
  isImage: boolean;
  imageUrls?: string[]; // post 多图/视频帧
  timeoutMs: number;
  strategy?: ProviderStrategy; // default 'auto'
  // route handler 已为 dedup key 加载过 primary 的 active prompt；透传复用，省一次 KV 读。
  // 仅当 provider 与此处 provider 匹配时复用，否则照常 loadActivePromptCached。
  primaryPrompt?: { version: number; content: string; provider: Provider };
}

/**
 * Runs the provider call and parses/validates the output.
 * Tries primary, falls back to secondary on PROVIDER_ERROR / PROVIDER_TIMEOUT.
 */
export async function executeModeration(
  env: Env,
  args: ExecuteArgs,
): Promise<ExecutionResult> {
  const route = resolveRoute(args.bizType, args.strategy ?? "auto");
  const primaryOpen = !(await canTry(env.NONCE, route.primary));

  // If primary circuit is open, skip straight to fallback (if any)
  if (primaryOpen && route.fallback) {
    console.warn(`[pipeline] ${route.primary} circuit open, going fallback ${route.fallback}`);
    return await tryProvider(env, args, route.fallback, false);
  }

  try {
    return await tryProvider(env, args, route.primary, true);
  } catch (err) {
    if (!route.fallback) throw err;
    if (!(err instanceof AppError)) throw err;
    if (
      err.code !== ErrorCodes.PROVIDER_ERROR &&
      err.code !== ErrorCodes.PROVIDER_TIMEOUT &&
      err.code !== ErrorCodes.PROVIDER_AUTH_FAILED
    ) {
      throw err;
    }
    console.warn(
      `[pipeline] primary ${route.primary} failed (${err.code}); falling back to ${route.fallback}`,
    );
    try {
      return await tryProvider(env, args, route.fallback, false);
    } catch (fbErr) {
      // 两家都挂 — 如果都是 auth 失败，包装为 SERVICE_UNAVAILABLE 503。
      // 2026-06-04 后 gemini 全平台下线，所有 route.fallback === null，此分支实际不可达；
      // 保留 dormant 结构以便未来引入新 fallback provider 时复用。
      if (
        err.code === ErrorCodes.PROVIDER_AUTH_FAILED &&
        fbErr instanceof AppError &&
        fbErr.code === ErrorCodes.PROVIDER_AUTH_FAILED
      ) {
        throw new AppError(
          ErrorCodes.SERVICE_UNAVAILABLE,
          503,
          "both providers failed authentication — platform tokens invalid/expired, please wait",
        );
      }
      throw fbErr;
    }
  }
}

/**
 * M16(c): 从 AppError.details 提取 provider 名（如有）。route handler 写库归因用。
 */
export function getErrorProvider(err: unknown): string | null {
  if (!(err instanceof AppError)) return null;
  const d = err.details;
  if (d && typeof d === "object" && "provider" in d) {
    const v = (d as { provider?: unknown }).provider;
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

/**
 * M16(c): 把 provider 注入到 AppError.details 里，让调用方能归因失败的真凶。
 *   - 若 details 已含 provider（fallback 二次包）→ 原样返回，不覆盖
 *   - 若 details 是 string（adapter 写的 body）→ 转 { provider, body }
 *   - 若 details 是其他 object → 浅合并加 provider
 *   - 其他（undefined/null/原始值）→ { provider } 或 { provider, original }
 */
function annotateProviderOnError(err: AppError, provider: Provider): AppError {
  const d = err.details;
  if (d && typeof d === "object" && "provider" in d) {
    return err; // 已归因，不覆盖
  }
  let newDetails: Record<string, unknown>;
  if (typeof d === "string") {
    // body 仅记服务端日志，不回传客户端（publicDetails 会在序列化时丢弃 body）。
    console.warn(`[pipeline] ${provider} upstream error body:`, d.slice(0, 500));
    newDetails = { provider, body: d };
  } else if (d && typeof d === "object") {
    newDetails = { ...(d as Record<string, unknown>), provider };
  } else if (d === undefined || d === null) {
    newDetails = { provider };
  } else {
    newDetails = { provider, original: d };
  }
  return new AppError(err.code, err.status, err.message, newDetails);
}

async function tryProvider(
  env: Env,
  args: ExecuteArgs,
  provider: Provider,
  recordCircuit: boolean,
): Promise<ExecutionResult> {
  try {
    const r = await callProvider(env, args, provider);
    if (recordCircuit && r.status !== "error") {
      // schema errors don't indicate provider outage — only close on real success
      await recordSuccess(env.NONCE, provider);
    }
    return r;
  } catch (err) {
    if (recordCircuit && err instanceof AppError) {
      // Auth failures: 10-min circuit + immediate Telegram/email alert
      if (err.code === ErrorCodes.PROVIDER_AUTH_FAILED) {
        await recordAuthFailure(env.NONCE, provider);
        // Fire-and-forget alert (don't block user request)
        alertProviderAuthFailed(env, provider, err.message, err.details).catch((e) =>
          console.warn("[alert] auth-failed notify error:", e),
        );
      } else if (
        err.code === ErrorCodes.PROVIDER_ERROR ||
        err.code === ErrorCodes.PROVIDER_TIMEOUT
      ) {
        await recordFailure(env.NONCE, provider);
      }
    }
    // M16(c): 给 AppError 注入 provider 让 route handler 写库能归因到真凶
    if (err instanceof AppError) {
      throw annotateProviderOnError(err, provider);
    }
    throw err;
  }
}

async function callProvider(
  env: Env,
  args: ExecuteArgs,
  provider: Provider,
): Promise<ExecutionResult> {
  const prompt =
    args.primaryPrompt && args.primaryPrompt.provider === provider
      ? args.primaryPrompt
      : await loadActivePromptCached(env, args.bizType, provider);
  if (!prompt) {
    throw new AppError(
      ErrorCodes.INTERNAL,
      500,
      `no active prompt for ${args.bizType}/${provider}`,
    );
  }
  const adapter = getAdapter(env, provider);
  const r = await adapter.moderate({
    systemPrompt: prompt.content,
    content: args.content,
    isImage: args.isImage,
    imageUrls: args.imageUrls,
    timeoutMs: args.timeoutMs,
  });

  const parsed = tryParseModelOutput(r.rawText);
  if (!parsed.ok) {
    return {
      status: "error",
      risk_level: null,
      categories: [],
      reason: `schema error: ${parsed.reason}`,
      provider,
      model: r.model,
      prompt_version: prompt.version,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      latency_ms: r.latencyMs,
      error_code: ErrorCodes.SCHEMA_ERROR,
    };
  }

  return {
    status: parsed.value.status,
    risk_level: parsed.value.risk_level,
    categories: parsed.value.categories,
    reason: parsed.value.reason,
    labels: parsed.value.labels,
    provider,
    model: r.model,
    prompt_version: prompt.version,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    latency_ms: r.latencyMs,
  };
}

function tryParseModelOutput(raw: string): { ok: true; value: ModelOutput } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "empty output" };
  // Strip ```json fences if a model ignores response_format
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "");
    s = s.trim();
  }
  let json: unknown;
  try {
    json = JSON.parse(s);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = ModelOutput.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }
  return { ok: true, value: parsed.data };
}
