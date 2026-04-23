import { z } from "zod";

// =============================================================
// Locked output contract. Do not remove fields or change semantics.
// =============================================================

export const BizType = z.enum(["comment", "nickname", "bio", "avatar"]);
export type BizType = z.infer<typeof BizType>;

export const Provider = z.enum(["grok", "gemini"]);
export type Provider = z.infer<typeof Provider>;

export const Status = z.enum(["pass", "reject", "review", "error"]);
export type Status = z.infer<typeof Status>;

export const RiskLevel = z.enum(["safe", "low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Category = z.enum([
  "politics",
  "porn",
  "abuse",
  "ad",
  "spam",
  "violence",
  "other",
]);
export type Category = z.infer<typeof Category>;

/** Strict schema expected from the model. */
export const ModelOutput = z.object({
  status: z.enum(["pass", "reject", "review"]),
  risk_level: RiskLevel,
  categories: z.array(Category).default([]),
  reason: z.string().max(512).default(""),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

/** Inbound /v1/moderate request. */
export const ModerateRequestSchema = z.object({
  biz_type: BizType,
  biz_id: z.string().min(1).max(128),
  content: z.string().min(1).max(16 * 1024),
  user_id: z.string().max(128).optional(),
  mode: z.enum(["sync", "async", "auto"]).default("auto"),
  callback_url: z.string().url().optional(),
  extra: z.record(z.string(), z.any()).optional(),
});
export type ModerateRequest = z.infer<typeof ModerateRequestSchema>;

/** The JSON that is POSTed to app.callback_url. */
export const CallbackBody = z.object({
  schema_version: z.literal("1.0"),
  request_id: z.string(),
  app_id: z.string(),
  biz_type: BizType,
  biz_id: z.string(),
  user_id: z.string().nullable(),
  status: Status,
  risk_level: RiskLevel.nullable(),
  categories: z.array(Category),
  reason: z.string(),
  provider: Provider.nullable(),
  model: z.string().nullable(),
  prompt_version: z.number().int().nullable(),
  cached: z.boolean(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  latency_ms: z.number().int().nonnegative(),
  extra: z.record(z.string(), z.any()).optional(),
  created_at: z.string(),
});
export type CallbackBody = z.infer<typeof CallbackBody>;

/** Shape persisted in KV DEDUP_CACHE — the reusable core of a result. */
export const CachedResult = z.object({
  status: Status,
  risk_level: RiskLevel.nullable(),
  categories: z.array(Category),
  reason: z.string(),
  provider: Provider.nullable(),
  model: z.string().nullable(),
  prompt_version: z.number().int().nullable(),
});
export type CachedResult = z.infer<typeof CachedResult>;

/** Core result returned by pipeline.execute. */
export interface ExecutionResult extends CachedResult {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code?: string;
}
