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
  timeoutMs: number;
  strategy?: ProviderStrategy; // default 'auto'
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
      // 两家都挂 — 如果都是 auth 失败，包装为 SERVICE_UNAVAILABLE 503
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
    throw err;
  }
}

async function callProvider(
  env: Env,
  args: ExecuteArgs,
  provider: Provider,
): Promise<ExecutionResult> {
  const prompt = await loadActivePromptCached(env, args.bizType, provider);
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
