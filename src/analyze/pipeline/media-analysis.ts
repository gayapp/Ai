import { AppError, ErrorCodes } from "../../lib/errors.ts";
import type { AnalyzeProvider, AnalyzeRow } from "../types.ts";
import { canonicalJson } from "../dedup.ts";
import { loadActiveAnalyzePromptCached } from "../prompts.ts";
import {
  MediaAnalysisInput,
  MediaAnalysisOutput,
  type MediaAnalysisInputT,
  type MediaAnalysisOutputT,
} from "../schema/media-analysis.ts";
import { completeAnalyze } from "../../db/analyze-requests.ts";
import { callGeminiMediaAnalysis } from "../providers/gemini-media.ts";
import { callXaiMediaAnalysis } from "../providers/xai-media.ts";
import { resolveAnalyzeRoute } from "../../providers/router.ts";
import {
  canTry,
  recordAuthFailure,
  recordFailure,
  recordSuccess,
} from "../../providers/circuit.ts";

type MediaAnalysisProvider = Extract<AnalyzeProvider, "gemini" | "xai">;

interface CachedMediaAnalysis {
  result: MediaAnalysisOutputT;
  provider: MediaAnalysisProvider;
  model: string;
  prompt_version: number;
}

interface ExecutionContext {
  provider: MediaAnalysisProvider | null;
  promptVersion: number | null;
}

interface MediaAnalysisRun {
  provider: MediaAnalysisProvider;
  model: string;
  promptVersion: number;
  cacheKey: string;
  cached: boolean;
  output: MediaAnalysisOutputT;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function executeMediaAnalysis(env: Env, row: AnalyzeRow): Promise<void> {
  const context: ExecutionContext = { provider: null, promptVersion: null };
  try {
    const input = parseInput(row.input_json);
    const run = await runMediaAnalysisRoute(env, row.input_hash, input, context);
    if (run.cached) {
      await completeAnalyze(env.DB, {
        id: row.id,
        cached: true,
        status: "ok",
        result_json: canonicalJson(run.output),
        provider: run.provider,
        model: run.model,
        prompt_version: run.promptVersion,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: null,
      });
      return;
    }

    const resultJson = canonicalJson(run.output);
    await completeAnalyze(env.DB, {
      id: row.id,
      cached: false,
      status: "ok",
      result_json: resultJson,
      provider: run.provider,
      model: run.model,
      prompt_version: run.promptVersion,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      latency_ms: run.latencyMs,
      error_code: null,
    });

    const ttl = parseInt(env.DEDUP_TTL_SECONDS || "604800", 10);
    await env.DEDUP_CACHE.put(
      run.cacheKey,
      JSON.stringify({
        result: run.output,
        provider: run.provider,
        model: run.model,
        prompt_version: run.promptVersion,
      } satisfies CachedMediaAnalysis),
      { expirationTtl: ttl },
    );
  } catch (e) {
    const code = e instanceof AppError ? e.code : ErrorCodes.INTERNAL;
    const msg = e instanceof Error ? e.message : String(e);
    await completeAnalyze(env.DB, {
      id: row.id,
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
    console.warn("[media-analysis] failed", row.id, msg);
  }
}

async function runMediaAnalysisRoute(
  env: Env,
  inputHash: string,
  input: MediaAnalysisInputT,
  context: ExecutionContext,
): Promise<MediaAnalysisRun> {
  const route = resolveAnalyzeRoute("media_analysis");
  const primary = toMediaAnalysisProvider(route.primary);
  const fallback = route.fallback ? toMediaAnalysisProvider(route.fallback) : null;
  const primaryCanTry = await canTry(env.NONCE, primary, "media_analysis");

  if (!primaryCanTry) {
    if (fallback && await canTry(env.NONCE, fallback, "media_analysis")) {
      console.warn(`[media-analysis] ${primary} circuit open, using fallback ${fallback}`);
      return await tryMediaAnalysisProvider(env, fallback, inputHash, input, context);
    }
    throw new AppError(
      ErrorCodes.SERVICE_UNAVAILABLE,
      503,
      `media_analysis providers unavailable; primary ${primary} circuit open`,
    );
  }

  try {
    return await tryMediaAnalysisProvider(env, primary, inputHash, input, context);
  } catch (err) {
    if (!fallback || !(err instanceof AppError) || !isFallbackableProviderError(err.code)) {
      throw err;
    }
    if (!(await canTry(env.NONCE, fallback, "media_analysis"))) {
      throw err;
    }
    console.warn(
      `[media-analysis] primary ${primary} failed (${err.code}); falling back to ${fallback}`,
    );
    return await tryMediaAnalysisProvider(env, fallback, inputHash, input, context);
  }
}

async function tryMediaAnalysisProvider(
  env: Env,
  provider: MediaAnalysisProvider,
  inputHash: string,
  input: MediaAnalysisInputT,
  context: ExecutionContext,
): Promise<MediaAnalysisRun> {
  context.provider = provider;
  const prompt = await loadActiveAnalyzePromptCached(env, "media_analysis", provider);
  if (!prompt) {
    throw new AppError(
      ErrorCodes.INTERNAL,
      500,
      `no active prompt for media_analysis/${provider}`,
    );
  }
  context.promptVersion = prompt.version;

  const cacheKey = mediaAnalysisDedupKey(prompt.version, inputHash);
  const cached = await getCachedMediaAnalysis(env.DEDUP_CACHE, cacheKey);
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
    const providerResult = await callMediaAnalysisProvider(env, provider, {
      prompt: buildMediaAnalysisPrompt(prompt.content, input),
      input,
      timeoutMs: 90_000,
    });
    const output = parseOutput(providerResult.rawText);
    await recordSuccess(env.NONCE, provider, "media_analysis");
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
        await recordAuthFailure(env.NONCE, provider, "media_analysis");
      } else if (
        err.code === ErrorCodes.PROVIDER_ERROR ||
        err.code === ErrorCodes.PROVIDER_TIMEOUT
      ) {
        await recordFailure(env.NONCE, provider, "media_analysis");
      }
    }
    throw err;
  }
}

function isFallbackableProviderError(code: string): boolean {
  return code === ErrorCodes.PROVIDER_ERROR ||
    code === ErrorCodes.PROVIDER_TIMEOUT ||
    code === ErrorCodes.PROVIDER_AUTH_FAILED ||
    code === ErrorCodes.UNSUPPORTED_CONTENT;
}

function toMediaAnalysisProvider(provider: AnalyzeProvider): MediaAnalysisProvider {
  if (provider === "gemini" || provider === "xai") return provider;
  throw new AppError(
    ErrorCodes.INTERNAL,
    500,
    `unsupported media_analysis provider '${provider}'`,
  );
}

async function callMediaAnalysisProvider(
  env: Env,
  provider: MediaAnalysisProvider,
  args: {
    prompt: string;
    input: MediaAnalysisInputT;
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
    case "gemini":
      return await callGeminiMediaAnalysis(env, args);
    case "xai":
      return await callXaiMediaAnalysis(env, args);
  }
}

export function buildMediaAnalysisPrompt(
  basePrompt: string,
  input: MediaAnalysisInputT,
): string {
  const frameLines = input.image_urls.map((_, index) => {
    const meta = input.frame_metadata?.[index];
    const timestamp = meta?.timestamp_seconds ?? index;
    const quality = meta?.quality_score ?? "unknown";
    const scene = meta?.scene_id ?? "unknown";
    return `- frame_index=${index + 1}, timestamp_seconds=${timestamp}, quality_score=${quality}, scene_id=${scene}`;
  });
  const nRule = input.image_urls.length === 1
    ? "Since N=1, return description, score, and scoring_breakdown. Omit cover_candidates, trial, and frame_notes."
    : "Since N>1, return cover_candidates, trial, and frame_notes. Omit description, score, and scoring_breakdown unless explicitly useful.";

  return `${basePrompt.trim()}

Input context:
- image_count: ${input.image_urls.length}
- title: ${input.title || "none"}
- duration_seconds: ${input.duration_seconds ?? "none"}
- region_hint: ${input.region_hint || "none"}
- sampled_frames:
${frameLines.join("\n")}

${nRule}

Use snake_case response field names exactly as specified by the response schema.`;
}

function parseInput(raw: string): MediaAnalysisInputT {
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
  const parsed = MediaAnalysisInput.safeParse(json);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, parsed.error.message);
  }
  if (parsed.data.frame_metadata && parsed.data.frame_metadata.length !== parsed.data.image_urls.length) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      "frame_metadata length must match image_urls length",
    );
  }
  return parsed.data;
}

function parseOutput(raw: string): MediaAnalysisOutputT {
  if (!raw) {
    throw new AppError(ErrorCodes.SCHEMA_VALIDATION_FAILED, 500, "empty provider output");
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
  const parsed = MediaAnalysisOutput.safeParse(json);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.SCHEMA_VALIDATION_FAILED, 500, parsed.error.message);
  }
  return parsed.data;
}

function mediaAnalysisDedupKey(promptVersion: number, inputHash: string): string {
  return `media_analysis:${promptVersion}:${inputHash}`;
}

async function getCachedMediaAnalysis(
  kv: KVNamespace,
  key: string,
): Promise<CachedMediaAnalysis | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedMediaAnalysis;
    const result = MediaAnalysisOutput.parse(parsed.result);
    const provider = parsed.provider === "xai" ? "xai" : "gemini";
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
