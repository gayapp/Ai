import { z } from "zod";
import { ANALYZE_BIZ_TYPES, DELIVERY_MODE } from "./envelope.ts";

export const AnalyzeCallbackBody = z.object({
  schema_version: z.literal("1.1"),
  request_id: z.string(),
  app_id: z.string(),
  biz_type: z.enum(ANALYZE_BIZ_TYPES),
  biz_id: z.string(),
  user_id: z.string().nullable(),
  status: z.enum(["ok", "error"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error_code: z.string().optional(),
  message: z.string().optional(),
  provider: z.enum(["grok", "gemini", "xai"]).nullable(),
  model: z.string().nullable(),
  prompt_version: z.number().int().nullable(),
  cached: z.boolean(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  latency_ms: z.number().int().nonnegative(),
  delivery_mode: z.enum(DELIVERY_MODE),
  extra: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
});

export type AnalyzeCallbackBody = z.infer<typeof AnalyzeCallbackBody>;
