import { z } from "zod";

export const MediaIntroInput = z.object({
  title: z.string().min(1).max(512),
  duration_seconds: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  frame_notes: z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    summary: z.string(),
  })).optional(),
  ocr_lines: z.array(z.string()).optional(),
  subtitle_text: z.string().optional(),
  trial_excerpt: z.string().optional(),
  style_hint: z.enum(["concise", "narrative", "marketing"]).optional(),
  max_length: z.number().int().min(50).max(2000).optional(),
});

export const MediaIntroOutput = z.object({
  intro: z.string().min(1),
  title_suggestions: z.array(z.string()).max(3).optional(),
  beats: z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    summary: z.string(),
  })).optional(),
});

export type MediaIntroInputT = z.infer<typeof MediaIntroInput>;
export type MediaIntroOutputT = z.infer<typeof MediaIntroOutput>;

export const MediaIntroResponseSchema = {
  type: "object",
  properties: {
    intro: { type: "string" },
    title_suggestions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    beats: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp_seconds: { type: "number" },
          summary: { type: "string" },
        },
        required: ["timestamp_seconds", "summary"],
      },
    },
  },
  required: ["intro"],
} as const;
