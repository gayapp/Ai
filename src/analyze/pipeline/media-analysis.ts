import { AppError, ErrorCodes } from "../../lib/errors.ts";
import type { AnalyzeRow } from "../types.ts";
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

interface CachedMediaAnalysis {
  result: MediaAnalysisOutputT;
  provider: "gemini";
  model: string;
  prompt_version: number;
}

export async function executeMediaAnalysis(env: Env, row: AnalyzeRow): Promise<void> {
  let promptVersion: number | null = null;
  try {
    const input = parseInput(row.input_json);
    const prompt = await loadActiveAnalyzePromptCached(env, "media_analysis", "gemini");
    if (!prompt) {
      throw new AppError(
        ErrorCodes.INTERNAL,
        500,
        "no active prompt for media_analysis/gemini",
      );
    }
    promptVersion = prompt.version;

    const cacheKey = mediaAnalysisDedupKey(prompt.version, row.input_hash);
    const cached = await getCachedMediaAnalysis(env.DEDUP_CACHE, cacheKey);
    if (cached) {
      await completeAnalyze(env.DB, {
        id: row.id,
        cached: true,
        status: "ok",
        result_json: canonicalJson(cached.result),
        provider: cached.provider,
        model: cached.model,
        prompt_version: cached.prompt_version,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: null,
      });
      return;
    }

    const providerResult = await callGeminiMediaAnalysis(env, {
      prompt: buildMediaAnalysisPrompt(prompt.content, input),
      input,
      timeoutMs: 90_000,
    });
    const output = parseOutput(providerResult.rawText);
    const resultJson = canonicalJson(output);
    await completeAnalyze(env.DB, {
      id: row.id,
      cached: false,
      status: "ok",
      result_json: resultJson,
      provider: "gemini",
      model: providerResult.model,
      prompt_version: prompt.version,
      input_tokens: providerResult.inputTokens,
      output_tokens: providerResult.outputTokens,
      latency_ms: providerResult.latencyMs,
      error_code: null,
    });

    const ttl = parseInt(env.DEDUP_TTL_SECONDS || "604800", 10);
    await env.DEDUP_CACHE.put(
      cacheKey,
      JSON.stringify({
        result: output,
        provider: "gemini",
        model: providerResult.model,
        prompt_version: prompt.version,
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
      provider: code === ErrorCodes.INVALID_REQUEST ? null : "gemini",
      model: null,
      prompt_version: promptVersion,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_code: code,
    });
    console.warn("[media-analysis] failed", row.id, msg);
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
    throw new AppError(ErrorCodes.SCHEMA_VALIDATION_FAILED, 500, "empty Gemini output");
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
      `invalid Gemini JSON: ${e instanceof Error ? e.message : String(e)}`,
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
    return {
      result,
      provider: "gemini",
      model: parsed.model,
      prompt_version: parsed.prompt_version,
    };
  } catch {
    return null;
  }
}
