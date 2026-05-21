import { Hono } from "hono";
import { z } from "zod";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import {
  invalidatePromptCache,
  listPromptsFor,
  publishPrompt,
  rollbackPrompt,
} from "../db/queries.ts";
import { adminActorFromHeaders, logAdminAuditBestEffort } from "../db/admin-audit.ts";
import { ANALYZE_BIZ_TYPES } from "../analyze/schema/envelope.ts";
import { buildMediaAnalysisPrompt } from "../analyze/pipeline/media-analysis.ts";
import { buildMediaIntroPrompt } from "../analyze/pipeline/media-intro.ts";
import { callGeminiTextJson } from "../analyze/providers/gemini-text.ts";
import { callXaiTextJson } from "../analyze/providers/xai-text.ts";
import { MediaAnalysisInput } from "../analyze/schema/media-analysis.ts";
import { MediaIntroInput, MediaIntroOutput } from "../analyze/schema/media-intro.ts";
import { BizType, ModelOutput, Provider } from "../moderation/schema.ts";
import { getAdapter } from "../providers/router.ts";

export const adminPromptsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminPromptsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

const MODERATE_BIZ_TYPES = ["comment", "nickname", "bio", "avatar"] as const;
const PROMPT_BIZ_TYPES = [...MODERATE_BIZ_TYPES, ...ANALYZE_BIZ_TYPES] as const;
const PROMPT_PROVIDERS = ["grok", "gemini", "xai"] as const;
const PromptBizType = z.enum(PROMPT_BIZ_TYPES);
const PromptProvider = z.enum(PROMPT_PROVIDERS);

adminPromptsRouter.get("/", async (c) => {
  const biz_type = PromptBizType.parse(c.req.query("biz_type"));
  const provider = PromptProvider.parse(c.req.query("provider"));
  assertPromptRoute(biz_type, provider);
  const rows = await listPromptsFor(c.env.DB, biz_type, provider);
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      biz_type: r.biz_type,
      provider: r.provider,
      version: r.version,
      content: r.content,
      is_active: !!r.is_active,
      created_by: r.created_by,
      created_at: r.created_at,
    })),
  });
});

const PublishSchema = z.object({
  biz_type: PromptBizType,
  provider: PromptProvider,
  content: z.string().min(1).max(20_000),
  created_by: z.string().optional(),
});

adminPromptsRouter.post("/", async (c) => {
  const body = PublishSchema.parse(await c.req.json());
  assertPromptRoute(body.biz_type, body.provider);
  const row = await publishPrompt(
    c.env.DB,
    body.biz_type,
    body.provider,
    body.content,
    body.created_by ?? "admin",
  );
  await invalidatePromptCache(c.env, body.biz_type, body.provider);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "prompt.publish",
    target_type: "prompt",
    target_id: String(row.id),
    metadata: {
      biz_type: row.biz_type,
      provider: row.provider,
      version: row.version,
      content_length: body.content.length,
      created_by: body.created_by ?? "admin",
    },
  });
  return c.json({
    id: row.id,
    biz_type: row.biz_type,
    provider: row.provider,
    version: row.version,
    is_active: !!row.is_active,
  }, 201);
});

adminPromptsRouter.post("/:id/rollback", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "bad id");
  }
  const row = await rollbackPrompt(c.env.DB, id);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "prompt not found");
  assertPromptRoute(row.biz_type, row.provider);
  await invalidatePromptCache(c.env, row.biz_type, row.provider);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "prompt.rollback",
    target_type: "prompt",
    target_id: String(row.id),
    metadata: {
      biz_type: row.biz_type,
      provider: row.provider,
      version: row.version,
    },
  });
  return c.json({
    id: row.id,
    biz_type: row.biz_type,
    provider: row.provider,
    version: row.version,
    is_active: !!row.is_active,
  });
});

function assertPromptRoute(bizType: string, provider: string): void {
  const moderate = (MODERATE_BIZ_TYPES as readonly string[]).includes(bizType);
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

const DryRunSchema = z.object({
  biz_type: PromptBizType,
  provider: PromptProvider,
  content: z.string().min(1),
  samples: z.array(z.string().min(1)).min(1).max(20),
});

adminPromptsRouter.post("/dry-run", async (c) => {
  const body = DryRunSchema.parse(await c.req.json());
  assertPromptRoute(body.biz_type, body.provider);
  if ((MODERATE_BIZ_TYPES as readonly string[]).includes(body.biz_type)) {
    return c.json({ results: await dryRunModerate(c.env, body) });
  }
  if (body.biz_type === "media_intro") {
    return c.json({ results: await dryRunMediaIntro(c.env, body) });
  }
  return c.json({ results: dryRunMediaAnalysisPrompt(body) });
});

async function dryRunModerate(
  env: Env,
  body: z.infer<typeof DryRunSchema>,
): Promise<Array<Record<string, unknown>>> {
  const bizType = BizType.parse(body.biz_type);
  const provider = Provider.parse(body.provider);
  const adapter = getAdapter(env, provider);
  const isImage = bizType === "avatar";
  const results = await Promise.all(
    body.samples.map(async (sample) => {
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
        } catch { /* keep schema_ok false */ }
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
    }),
  );
  return results;
}

async function dryRunMediaIntro(
  env: Env,
  body: z.infer<typeof DryRunSchema>,
): Promise<Array<Record<string, unknown>>> {
  const provider = z.enum(["xai", "gemini"]).parse(body.provider);
  return await Promise.all(
    body.samples.map(async (sample) => {
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
    }),
  );
}

function dryRunMediaAnalysisPrompt(
  body: z.infer<typeof DryRunSchema>,
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
