import { completeAnalyze } from "../../db/analyze-requests.ts";
import { AppError, ErrorCodes } from "../../lib/errors.ts";
import {
  canTry,
  recordAuthFailure,
  recordFailure,
  recordSuccess,
} from "../../providers/circuit.ts";
import { resolveAnalyzeRoute } from "../../providers/router.ts";
import { canonicalJson } from "../dedup.ts";
import { callGeminiTextJson } from "../providers/gemini-text.ts";
import { callXaiTextJson } from "../providers/xai-text.ts";
import { loadActiveAnalyzePromptCached } from "../prompts.ts";
import {
  MediaIntroInput,
  MediaIntroOutput,
  type MediaIntroInputT,
  type MediaIntroOutputT,
} from "../schema/media-intro.ts";
import type { AnalyzeProvider, AnalyzeRow } from "../types.ts";
import type { ProviderStrategy } from "../../moderation/types.ts";

type MediaIntroProvider = Extract<AnalyzeProvider, "gemini" | "xai">;

interface CachedMediaIntro {
  result: MediaIntroOutputT;
  provider: MediaIntroProvider;
  model: string;
  prompt_version: number;
}

export interface MediaIntroExecutionContext {
  provider: MediaIntroProvider | null;
  promptVersion: number | null;
}

export interface MediaIntroRun {
  provider: MediaIntroProvider;
  model: string;
  promptVersion: number;
  cacheKey: string;
  cached: boolean;
  output: MediaIntroOutputT;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function executeMediaIntro(
  env: Env,
  row: AnalyzeRow,
  timeoutMs = 90_000,
  strategy: ProviderStrategy = "auto",
): Promise<void> {
  const context: MediaIntroExecutionContext = { provider: null, promptVersion: null };
  try {
    const input = parseMediaIntroInput(row.input_json);
    const run = await runMediaIntro(env, row.input_hash, input, timeoutMs, context, strategy);
    await completeMediaIntroOk(env, row.id, run);
    await cacheMediaIntro(env, run);
  } catch (e) {
    await completeMediaIntroError(env, row.id, e, context);
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[media-intro] failed", row.id, msg);
  }
}

export async function runMediaIntro(
  env: Env,
  inputHash: string,
  input: MediaIntroInputT,
  timeoutMs: number,
  context: MediaIntroExecutionContext = { provider: null, promptVersion: null },
  strategy: ProviderStrategy = "auto",
): Promise<MediaIntroRun> {
  const route = resolveAnalyzeRoute("media_intro", strategy);
  const primary = toMediaIntroProvider(route.primary);
  const fallback = route.fallback ? toMediaIntroProvider(route.fallback) : null;
  const primaryCanTry = await canTry(env.NONCE, primary, "media_intro");

  if (!primaryCanTry) {
    if (fallback && await canTry(env.NONCE, fallback, "media_intro")) {
      console.warn(`[media-intro] ${primary} circuit open, using fallback ${fallback}`);
      return await tryMediaIntroProvider(env, fallback, inputHash, input, timeoutMs, context);
    }
    throw new AppError(
      ErrorCodes.SERVICE_UNAVAILABLE,
      503,
      `media_intro providers unavailable; primary ${primary} circuit open`,
    );
  }

  try {
    return await tryMediaIntroProvider(env, primary, inputHash, input, timeoutMs, context);
  } catch (err) {
    if (!fallback || !(err instanceof AppError) || !isFallbackableProviderError(err.code)) {
      throw err;
    }
    if (!(await canTry(env.NONCE, fallback, "media_intro"))) {
      throw err;
    }
    console.warn(`[media-intro] primary ${primary} failed (${err.code}); falling back to ${fallback}`);
    return await tryMediaIntroProvider(env, fallback, inputHash, input, timeoutMs, context);
  }
}

export async function completeMediaIntroOk(
  env: Env,
  id: string,
  run: MediaIntroRun,
): Promise<void> {
  await completeAnalyze(env.DB, {
    id,
    cached: run.cached,
    status: "ok",
    result_json: canonicalJson(run.output),
    provider: run.provider,
    model: run.model,
    prompt_version: run.promptVersion,
    input_tokens: run.cached ? 0 : run.inputTokens,
    output_tokens: run.cached ? 0 : run.outputTokens,
    latency_ms: run.cached ? 0 : run.latencyMs,
    error_code: null,
  });
}

export async function completeMediaIntroError(
  env: Env,
  id: string,
  e: unknown,
  context: MediaIntroExecutionContext,
  overrideCode?: string,
): Promise<void> {
  const code = overrideCode ?? (e instanceof AppError ? e.code : ErrorCodes.INTERNAL);
  await completeAnalyze(env.DB, {
    id,
    cached: false,
    status: "error",
    result_json: null,
    provider: code === ErrorCodes.INVALID_REQUEST ? null : context.provider,
    model: null,
    prompt_version: context.promptVersion,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    error_code: code,
  });
}

export async function cacheMediaIntro(env: Env, run: MediaIntroRun): Promise<void> {
  if (run.cached) return;
  const ttl = parseInt(env.DEDUP_TTL_SECONDS || "604800", 10);
  await env.DEDUP_CACHE.put(
    run.cacheKey,
    JSON.stringify({
      result: run.output,
      provider: run.provider,
      model: run.model,
      prompt_version: run.promptVersion,
    } satisfies CachedMediaIntro),
    { expirationTtl: ttl },
  );
}

export function parseMediaIntroInput(raw: string): MediaIntroInputT {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      `invalid input_json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = MediaIntroInput.safeParse(json);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, parsed.error.message);
  }
  return parsed.data;
}

export function buildMediaIntroPrompt(basePrompt: string, input: MediaIntroInputT): string {
  return `${basePrompt.trim()}

Input:
${canonicalJson(input)}

Instructions:
- Return exactly one JSON object.
- Keep intro within max_length when provided; otherwise keep it concise.
- Use the requested style_hint when provided.
- title_suggestions must contain at most 3 items.
- beats should summarize important timestamps only when frame_notes or subtitle timing gives useful anchors.`;
}

async function tryMediaIntroProvider(
  env: Env,
  provider: MediaIntroProvider,
  inputHash: string,
  input: MediaIntroInputT,
  timeoutMs: number,
  context: MediaIntroExecutionContext,
): Promise<MediaIntroRun> {
  context.provider = provider;
  const prompt = await loadActiveAnalyzePromptCached(env, "media_intro", provider);
  if (!prompt) {
    throw new AppError(
      ErrorCodes.INTERNAL,
      500,
      `no active prompt for media_intro/${provider}`,
    );
  }
  context.promptVersion = prompt.version;

  const cacheKey = mediaIntroDedupKey(prompt.version, inputHash);
  const cached = await getCachedMediaIntro(env.DEDUP_CACHE, cacheKey);
  if (cached) {
    return {
      provider: cached.provider,
      model: cached.model,
      promptVersion: cached.prompt_version,
      cacheKey,
      cached: true,
      output: cached.result,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }

  try {
    const providerResult = await callMediaIntroProvider(env, provider, {
      prompt: buildMediaIntroPrompt(prompt.content, input),
      timeoutMs,
    });
    const output = parseOutput(providerResult.rawText);
    await recordSuccess(env.NONCE, provider, "media_intro");
    return {
      provider,
      model: providerResult.model,
      promptVersion: prompt.version,
      cacheKey,
      cached: false,
      output,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      latencyMs: providerResult.latencyMs,
    };
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === ErrorCodes.PROVIDER_AUTH_FAILED) {
        await recordAuthFailure(env.NONCE, provider, "media_intro");
      } else if (
        err.code === ErrorCodes.PROVIDER_ERROR ||
        err.code === ErrorCodes.PROVIDER_TIMEOUT
      ) {
        await recordFailure(env.NONCE, provider, "media_intro");
      }
    }
    throw err;
  }
}

function parseOutput(raw: string): MediaIntroOutputT {
  if (!raw) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 502, "empty provider output");
  }
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new AppError(
      ErrorCodes.SCHEMA_VALIDATION_FAILED,
      500,
      `invalid provider JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = MediaIntroOutput.safeParse(json);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.SCHEMA_VALIDATION_FAILED, 500, parsed.error.message);
  }
  return parsed.data;
}

function isFallbackableProviderError(code: string): boolean {
  return code === ErrorCodes.PROVIDER_ERROR ||
    code === ErrorCodes.PROVIDER_TIMEOUT ||
    code === ErrorCodes.PROVIDER_AUTH_FAILED;
}

function toMediaIntroProvider(provider: AnalyzeProvider): MediaIntroProvider {
  if (provider === "xai" || provider === "gemini") return provider;
  throw new AppError(
    ErrorCodes.INTERNAL,
    500,
    `unsupported media_intro provider '${provider}'`,
  );
}

async function callMediaIntroProvider(
  env: Env,
  provider: MediaIntroProvider,
  args: {
    prompt: string;
    timeoutMs: number;
  },
): Promise<{
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  switch (provider) {
    case "xai":
      return await callXaiTextJson(env, args);
    case "gemini":
      return await callGeminiTextJson(env, args);
  }
}

function mediaIntroDedupKey(promptVersion: number, inputHash: string): string {
  return `media_intro:${promptVersion}:${inputHash}`;
}

async function getCachedMediaIntro(
  kv: KVNamespace,
  key: string,
): Promise<CachedMediaIntro | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedMediaIntro;
    const result = MediaIntroOutput.parse(parsed.result);
    const provider = parsed.provider === "gemini" ? "gemini" : "xai";
    return {
      result,
      provider,
      model: parsed.model,
      prompt_version: parsed.prompt_version,
    };
  } catch {
    return null;
  }
}
