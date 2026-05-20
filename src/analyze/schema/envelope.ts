import { z } from "zod";

export const ANALYZE_BIZ_TYPES = ["media_analysis", "media_intro"] as const;
export const ANALYZE_MODE = ["sync", "async", "auto"] as const;
export const DELIVERY_MODE = ["callback", "pull", "both"] as const;

export const AnalyzeRequestEnvelope = z.object({
  biz_type: z.enum(ANALYZE_BIZ_TYPES),
  biz_id: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
  mode: z.enum(ANALYZE_MODE).optional().default("auto"),
  delivery_mode: z.enum(DELIVERY_MODE).optional(),
  callback_url: z.string().url().optional(),
  user_id: z.string().max(128).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type AnalyzeRequestEnvelopeT = z.infer<typeof AnalyzeRequestEnvelope>;
