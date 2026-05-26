import { z } from "zod";
import { ANALYZE_BIZ_TYPES } from "../analyze/schema/envelope.ts";
import { buildMediaAnalysisPrompt } from "../analyze/pipeline/media-analysis.ts";
import { buildMediaIntroPrompt } from "../analyze/pipeline/media-intro.ts";
import { callGeminiTextJson } from "../analyze/providers/gemini-text.ts";
import { callXaiTextJson } from "../analyze/providers/xai-text.ts";
import { MediaAnalysisInput } from "../analyze/schema/media-analysis.ts";
import { MediaIntroInput, MediaIntroOutput } from "../analyze/schema/media-intro.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { BizType, ModelOutput, Provider } from "../moderation/schema.ts";
import { getAdapter } from "../providers/router.ts";

export const MODERATE_PROMPT_BIZ_TYPES = ["comment", "nickname", "bio", "avatar"] as const;
export const PROMPT_BIZ_TYPES = [...MODERATE_PROMPT_BIZ_TYPES, ...ANALYZE_BIZ_TYPES] as const;
export const PROMPT_PROVIDERS = ["grok", "gemini", "xai"] as const;

export const PromptBizType = z.enum(PROMPT_BIZ_TYPES);
export const PromptProvider = z.enum(PROMPT_PROVIDERS);

export const PromptDryRunSchema = z.object({
  biz_type: PromptBizType,
  provider: PromptProvider,
  content: z.string().min(1),
  samples: z.array(z.string().min(1)).min(1).max(20),
});

export type PromptDryRunInput = z.infer<typeof PromptDryRunSchema>;

export function assertPromptRoute(bizType: string, provider: string): void {
  const moderate = (MODERATE_PROMPT_BIZ_TYPES as readonly string[]).includes(bizType);
  const analyze = (ANALYZE_BIZ_TYPES as readonly string[]).includes(bizType);
  const ok = moderate
    ? provider === "grok" || provider === "gemini"
    : analyze && (provider === "xai" || provider === "gemini");
  if (!ok) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      `provider '${provider}' is not valid for biz_type '${bizType}'`,
    );
  }
}

export async function dryRunPrompt(
  env: Env,
  body: PromptDryRunInput,
): Promise<Array<Record<string, unknown>>> {
  assertPromptRoute(body.biz_type, body.provider);
  if ((MODERATE_PROMPT_BIZ_TYPES as readonly string[]).includes(body.biz_type)) {
    return await dryRunModerate(env, body);
  }
  if (body.biz_type === "media_intro") {
    return await dryRunMediaIntro(env, body);
  }
  return dryRunMediaAnalysisPrompt(body);
}

async function dryRunModerate(
  env: Env,
  body: PromptDryRunInput,
): Promise<Array<Record<string, unknown>>> {
  const bizType = BizType.parse(body.biz_type);
  const provider = Provider.parse(body.provider);
  const adapter = getAdapter(env, provider);
  const isImage = bizType === "avatar";
  const concurrency = provider === "gemini" ? 1 : 4;
  const results = await mapWithConcurrency(
    body.samples,
    concurrency,
    async (sample) => {
      try {
        const r = await adapter.moderate({
          systemPrompt: body.content,
          content: sample,
          isImage,
          timeoutMs: 15_000,
        });
        let parsed: unknown;
        let schema_ok = false;
        try {
          parsed = JSON.parse(r.rawText);
          schema_ok = ModelOutput.safeParse(parsed).success;
        } catch {
          // keep schema_ok false
        }
        return {
          sample,
          rawText: r.rawText,
          parsed,
          schema_ok,
          tokens: { input: r.inputTokens, output: r.outputTokens },
          latency_ms: r.latencyMs,
        };
      } catch (e) {
        return { sample, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  return results;
}

async function dryRunMediaIntro(
  env: Env,
  body: PromptDryRunInput,
): Promise<Array<Record<string, unknown>>> {
  const provider = z.enum(["xai", "gemini"]).parse(body.provider);
  const concurrency = provider === "gemini" ? 1 : 4;
  return await mapWithConcurrency(
    body.samples,
    concurrency,
    async (sample) => {
      try {
        const inputRaw = parseJsonSample(sample);
        const input = MediaIntroInput.parse(inputRaw);
        const prompt = buildMediaIntroPrompt(body.content, input);
        const r = provider === "xai"
          ? await callXaiTextJson(env, { prompt, timeoutMs: 30_000 })
          : await callGeminiTextJson(env, { prompt, timeoutMs: 30_000 });
        const parsed = parseJsonText(r.rawText);
        const schema = MediaIntroOutput.safeParse(parsed);
        return {
          sample,
          dry_run_mode: "provider",
          rawText: r.rawText,
          parsed,
          schema_ok: schema.success,
          schema_error: schema.success ? null : schema.error.message,
          tokens: { input: r.inputTokens, output: r.outputTokens },
          latency_ms: r.latencyMs,
          model: r.model,
        };
      } catch (e) {
        return {
          sample,
          dry_run_mode: "provider",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );
}

function dryRunMediaAnalysisPrompt(
  body: PromptDryRunInput,
): Array<Record<string, unknown>> {
  return body.samples.map((sample) => {
    try {
      const inputRaw = parseJsonSample(sample);
      const input = MediaAnalysisInput.parse(inputRaw);
      if (input.frame_metadata && input.frame_metadata.length !== input.image_urls.length) {
        throw new AppError(
          ErrorCodes.INVALID_REQUEST,
          400,
          "frame_metadata length must match image_urls length",
        );
      }
      return {
        sample,
        dry_run_mode: "input_schema_and_prompt_preview",
        input_schema_ok: true,
        image_count: input.image_urls.length,
        prompt_preview: buildMediaAnalysisPrompt(body.content, input),
        note: "media_analysis dry-run validates input and prompt construction only; provider calls require real HTTPS images and are exercised through /v1/analyze smoke.",
      };
    } catch (e) {
      return {
        sample,
        dry_run_mode: "input_schema_and_prompt_preview",
        input_schema_ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

function parseJsonSample(sample: string): unknown {
  try {
    return JSON.parse(sample);
  } catch (e) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      `sample must be JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function parseJsonText(raw: string): unknown {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return JSON.parse(text);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
