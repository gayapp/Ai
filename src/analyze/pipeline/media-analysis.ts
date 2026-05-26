import { AppError, ErrorCodes } from "../../lib/errors.ts";
import type { AnalyzeProvider, AnalyzeRow } from "../types.ts";
import { canonicalJson } from "../dedup.ts";
import { loadActiveAnalyzePromptCached } from "../prompts.ts";
import {
  MediaAnalysisInput,
  MediaAnalysisOutput,
  REGION_CODES,
  type MediaAnalysisInputT,
  type MediaAnalysisOutputT,
} from "../schema/media-analysis.ts";
import { completeAnalyze } from "../../db/analyze-requests.ts";
import { callGeminiMediaAnalysis } from "../providers/gemini-media.ts";
import { callXaiMediaAnalysis } from "../providers/xai-media.ts";
import { resolveAnalyzeRoute } from "../../providers/router.ts";
import type { ProviderStrategy } from "../../moderation/types.ts";
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

export async function executeMediaAnalysis(
  env: Env,
  row: AnalyzeRow,
  strategy: ProviderStrategy = "auto",
): Promise<void> {
  const context: ExecutionContext = { provider: null, promptVersion: null };
  try {
    const input = parseInput(row.input_json);
    const run = await runMediaAnalysisRoute(env, row.input_hash, input, context, strategy);
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
    if (isRetryableAnalyzeExecutionError(code)) {
      console.warn("[media-analysis] retryable failure", row.id, code, msg);
      throw e;
    }
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

function isRetryableAnalyzeExecutionError(code: string): boolean {
  return code === ErrorCodes.SERVICE_UNAVAILABLE ||
    code === ErrorCodes.PROVIDER_AUTH_FAILED ||
    code === ErrorCodes.PROVIDER_ERROR ||
    code === ErrorCodes.PROVIDER_TIMEOUT;
}

async function runMediaAnalysisRoute(
  env: Env,
  inputHash: string,
  input: MediaAnalysisInputT,
  context: ExecutionContext,
  strategy: ProviderStrategy,
): Promise<MediaAnalysisRun> {
  const route = resolveAnalyzeRoute("media_analysis", strategy);
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
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 502, "empty provider output");
  }
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  const json = parseProviderJson(text);
  const parsed = MediaAnalysisOutput.safeParse(normalizeMediaAnalysisOutput(json));
  if (!parsed.success) {
    throw new AppError(ErrorCodes.SCHEMA_VALIDATION_FAILED, 500, parsed.error.message);
  }
  return parsed.data;
}

const MEDIA_ANALYSIS_KEYS = [
  "moderation",
  "tags",
  "ad_detection",
  "face_coordinates",
  "region",
  "description",
  "score",
  "scoring_breakdown",
  "cover_candidates",
  "trial",
  "frame_notes",
];

function normalizeMediaAnalysisOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const unwrapped = unwrapMediaAnalysisOutput(value);
  if (unwrapped !== value) return normalizeMediaAnalysisOutput(unwrapped);
  if (!MEDIA_ANALYSIS_KEYS.some((key) => key in value)) return value;
  const out: Record<string, unknown> = { ...value };
  out.moderation = normalizeModeration(out.moderation);
  out.tags = normalizeTags(out.tags);
  out.ad_detection = normalizeAdDetection(out.ad_detection);
  out.face_coordinates = Array.isArray(out.face_coordinates)
    ? out.face_coordinates.map(normalizeFaceCoordinate)
    : [];
  out.region = normalizeRegion(out.region);
  if ("description" in out) out.description = stringOr(out.description, "");
  if ("score" in out) out.score = integerInRange(out.score, 0, 0, 100);
  if ("scoring_breakdown" in out) out.scoring_breakdown = numericRecordOr(out.scoring_breakdown);
  if ("cover_candidates" in out) {
    out.cover_candidates = Array.isArray(out.cover_candidates)
      ? out.cover_candidates.slice(0, 5).map(normalizeCoverCandidate)
      : [];
  }
  if ("trial" in out) out.trial = normalizeTrial(out.trial);
  if ("frame_notes" in out) {
    out.frame_notes = Array.isArray(out.frame_notes) ? out.frame_notes.map(normalizeFrameNote) : [];
  }
  return out;
}

function unwrapMediaAnalysisOutput(value: Record<string, unknown>): unknown {
  for (const key of ["result", "analysis", "media_analysis", "data", "output"]) {
    const nested = value[key];
    if (isRecord(nested) && MEDIA_ANALYSIS_KEYS.some((mediaKey) => mediaKey in nested)) {
      return nested;
    }
  }
  return value;
}

function normalizeModeration(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  const decision = src.decision === "approve" || src.decision === "reject" || src.decision === "review"
    ? src.decision
    : "review";
  return {
    decision,
    confidence: numberInRange(src.confidence, 0, 0, 1),
    summary: stringOr(src.summary, "Provider output omitted moderation details; defaulted to review."),
    violations: Array.isArray(src.violations) ? src.violations.map(normalizeViolation) : [],
  };
}

function normalizeViolation(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  return {
    category: stringOr(src.category, "unknown"),
    detected: typeof src.detected === "boolean" ? src.detected : true,
    confidence: numberInRange(src.confidence, 0, 0, 1),
    evidence: stringOr(src.evidence, ""),
    ...(typeof src.frame_index === "number"
      ? { frame_index: integerInRange(src.frame_index, 0, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(typeof src.timestamp_seconds === "number"
      ? { timestamp_seconds: numberInRange(src.timestamp_seconds, 0, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
  };
}

function normalizeTags(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  const categories = isRecord(src.categories) ? src.categories : {};
  return {
    tag_names: stringArray(src.tag_names),
    extra_tag_names: stringArray(src.extra_tag_names),
    categories: {
      meta: recordOr(categories.meta),
      appearance: recordOr(categories.appearance),
      context: recordOr(categories.context),
      production: recordOr(categories.production),
    },
    summary: stringOr(src.summary, "Provider output omitted tag summary."),
    status: src.status === "ready" || src.status === "pending" ? src.status : "pending",
  };
}

function normalizeAdDetection(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  return {
    is_ad: typeof src.is_ad === "boolean" ? src.is_ad : false,
    categories: stringArray(src.categories),
    elements: stringArray(src.elements),
    contacts: stringArray(src.contacts),
    urls: stringArray(src.urls),
    reason: stringOr(src.reason, "Provider output did not report ad signals."),
  };
}

function normalizeRegion(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  const code = typeof src.code === "string" && REGION_CODES.includes(src.code as typeof REGION_CODES[number])
    ? src.code
    : "other";
  return {
    code,
    requested_code: stringOr(src.requested_code, "other"),
    confidence: numberInRange(src.confidence, 0, 0, 1),
    reasoning: stringOr(src.reasoning, "Provider output omitted region reasoning."),
    signals: recordOr(src.signals),
  };
}

function normalizeFaceCoordinate(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  const box = isRecord(src.box) ? src.box : {};
  return {
    ...(typeof src.frame_index === "number" ? { frame_index: Math.trunc(src.frame_index) } : {}),
    ...(typeof src.timestamp_seconds === "number"
      ? { timestamp_seconds: Math.max(0, src.timestamp_seconds) }
      : {}),
    box: {
      x: integerInRange(box.x, 0, 0, Number.MAX_SAFE_INTEGER),
      y: integerInRange(box.y, 0, 0, Number.MAX_SAFE_INTEGER),
      width: integerInRange(box.width, 0, 0, Number.MAX_SAFE_INTEGER),
      height: integerInRange(box.height, 0, 0, Number.MAX_SAFE_INTEGER),
    },
    orientation: stringOr(src.orientation, "unknown"),
    confidence: numberInRange(src.confidence, 0, 0, 1),
  };
}

function normalizeCoverCandidate(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  return {
    frame_index: integerInRange(src.frame_index, 1, 0, Number.MAX_SAFE_INTEGER),
    timestamp_seconds: numberInRange(src.timestamp_seconds, 0, 0, Number.MAX_SAFE_INTEGER),
    score: integerInRange(src.score, 0, 0, 100),
    scoring_breakdown: numericRecordOr(src.scoring_breakdown),
    reason: stringOr(src.reason, ""),
    is_recommended: typeof src.is_recommended === "boolean" ? src.is_recommended : false,
  };
}

function normalizeTrial(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  return {
    trial_start_seconds: integerInRange(src.trial_start_seconds, 0, 0, Number.MAX_SAFE_INTEGER),
    trial_end_seconds: integerInRange(src.trial_end_seconds, 0, 0, Number.MAX_SAFE_INTEGER),
    trial_score: numberInRange(src.trial_score, 0, 0, 1),
    reason: stringOr(src.reason, ""),
    status: src.status === "ready" || src.status === "pending" ? src.status : "pending",
  };
}

function normalizeFrameNote(value: unknown): Record<string, unknown> {
  const src = isRecord(value) ? value : {};
  return {
    frame_index: integerInRange(src.frame_index, 1, 0, Number.MAX_SAFE_INTEGER),
    timestamp_seconds: numberInRange(src.timestamp_seconds, 0, 0, Number.MAX_SAFE_INTEGER),
    summary: stringOr(src.summary, ""),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(numberInRange(value, fallback, min, max));
}

function numericRecordOr(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      out[key] = item;
    }
  }
  return out;
}

function parseProviderJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const extracted = extractFirstJsonObject(text);
    if (extracted) {
      try {
        return JSON.parse(extracted) as unknown;
      } catch {
        // fall through to the original parse error for a clearer message
      }
    }
    throw new AppError(
      ErrorCodes.SCHEMA_VALIDATION_FAILED,
      500,
      `invalid provider JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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
