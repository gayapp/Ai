import { AppError, ErrorCodes } from "../lib/errors.ts";
import { loadActivePromptCached } from "../db/queries.ts";
import {
  ModelOutput,
  type BizType,
  type ExecutionResult,
  type Provider,
} from "./schema.ts";
import { getAdapter, getRoute } from "../providers/router.ts";

export interface ExecuteArgs {
  bizType: BizType;
  content: string;
  isImage: boolean;
  timeoutMs: number;
}

/**
 * Runs the provider call and parses/validates the output.
 * Tries primary, falls back to secondary on PROVIDER_ERROR / PROVIDER_TIMEOUT.
 */
export async function executeModeration(
  env: Env,
  args: ExecuteArgs,
): Promise<ExecutionResult> {
  const route = getRoute(args.bizType);
  try {
    return await callProvider(env, args, route.primary);
  } catch (err) {
    if (!route.fallback) throw err;
    if (!(err instanceof AppError)) throw err;
    if (
      err.code !== ErrorCodes.PROVIDER_ERROR &&
      err.code !== ErrorCodes.PROVIDER_TIMEOUT
    ) {
      throw err;
    }
    console.warn(
      `[pipeline] primary ${route.primary} failed (${err.code}); falling back to ${route.fallback}`,
    );
    return await callProvider(env, args, route.fallback);
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
