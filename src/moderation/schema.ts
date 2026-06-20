import { z } from "zod";

// =============================================================
// Locked output contract. Do not remove fields or change semantics.
// =============================================================

export const BizType = z.enum(["comment", "nickname", "bio", "avatar", "post"]);
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

// =============================================================
// 结构化标签（post 多图/视频帧专用）。形状参考 analyze 的 ViolationSchema：
//   每一类回答"是否有(detected) + 是什么(evidence)"。
//   6 类零容忍 + 1 类描述性(nsfw 合法成人内容,不驱动 verdict)。
// =============================================================
export const LabelCategory = z.enum([
  "minor_face", // 疑似未成年人面孔出现（不一定违规,但需标注 → review）
  "csam", // 未成年性化 → 零容忍
  "ad", // 广告引流 → 零容忍
  "drug", // 毒品 → 零容忍
  "gambling", // 赌博 → 零容忍
  "politics", // 政治敏感 → 零容忍
  "id_document", // 身份证/护照/证件等可证明身份的图片 → 零容忍（隐私/合规）
  "nsfw", // 合法成人内容(描述性,不影响判定)
]);
export type LabelCategory = z.infer<typeof LabelCategory>;

export const ModerationLabel = z.object({
  category: LabelCategory,
  detected: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.string().max(512).default(""), // "是什么"——命中位置/描述
});
export type ModerationLabel = z.infer<typeof ModerationLabel>;

/** Strict schema expected from the model. */
export const ModelOutput = z.object({
  status: z.enum(["pass", "reject", "review"]),
  risk_level: RiskLevel,
  categories: z.array(Category).default([]),
  reason: z.string().max(512).default(""),
  // 仅 post 多图要求模型产出；文本类不返回也通过校验。
  labels: z.array(ModerationLabel).optional(),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

/** Inbound /v1/moderate request. */
export const ModerateRequestSchema = z
  .object({
    biz_type: BizType,
    biz_id: z.string().min(1).max(128),
    // content min 由 superRefine 按 biz_type 控制：非 post 必填、post 可空（有图即可）。
    content: z.string().max(16 * 1024).default(""),
    // post 专用多图入参；每个为 https 公网图 URL，整组 ≤12 张。
    image_urls: z
      .array(z.string().url().startsWith("https://"))
      .max(12)
      .optional(),
    user_id: z.string().max(128).optional(),
    mode: z.enum(["sync", "async", "auto"]).default("auto"),
    callback_url: z.string().url().optional(),
    extra: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.biz_type === "post") {
      // post：content 与 image_urls 至少其一非空。
      const hasText = v.content.trim().length > 0;
      const hasImages = !!v.image_urls && v.image_urls.length > 0;
      if (!hasText && !hasImages) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: "post requires non-empty content or image_urls",
        });
      }
    } else {
      // 非 post：保留原行为——content 必填；且禁止携带 image_urls。
      if (v.content.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: "content must not be empty",
        });
      }
      if (v.image_urls !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["image_urls"],
          message: "image_urls is only allowed for biz_type 'post'",
        });
      }
    }
  });
export type ModerateRequest = z.infer<typeof ModerateRequestSchema>;

/** 该请求是否需要视觉模型：avatar 单图，或 post 带图（多图/视频帧）。 */
export function requestIsImage(bizType: BizType, imageUrls?: string[] | null): boolean {
  if (bizType === "avatar") return true;
  if (bizType === "post") return !!imageUrls && imageUrls.length > 0;
  return false;
}

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
  // 结构化标签（post）。只增字段、向后兼容；旧消费方忽略未知字段。
  labels: z.array(ModerationLabel).optional(),
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
  labels: z.array(ModerationLabel).optional(),
});
export type CachedResult = z.infer<typeof CachedResult>;

/** Core result returned by pipeline.execute. */
export interface ExecutionResult extends CachedResult {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code?: string;
}
