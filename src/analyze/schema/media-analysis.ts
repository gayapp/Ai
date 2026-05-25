import { z } from "zod";

export const MediaAnalysisInput = z.object({
  image_urls: z.array(z.string().url().startsWith("https://")).min(1).max(16),
  title: z.string().max(2048).optional(),
  duration_seconds: z.number().int().nonnegative().optional(),
  frame_metadata: z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    quality_score: z.number().nonnegative(),
    scene_id: z.number().int().optional(),
  })).optional(),
  region_hint: z.string().optional(),
});

const ViolationSchema = z.object({
  category: z.string(),
  detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
  frame_index: z.number().int().optional(),
  timestamp_seconds: z.number().nonnegative().optional(),
});

const ModerationSchema = z.object({
  decision: z.enum(["approve", "reject", "review"]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  violations: z.array(ViolationSchema),
});

const TagsSchema = z.object({
  tag_names: z.array(z.string()),
  extra_tag_names: z.array(z.string()),
  categories: z.object({
    meta: z.record(z.string(), z.unknown()),
    appearance: z.record(z.string(), z.unknown()),
    context: z.record(z.string(), z.unknown()),
    production: z.record(z.string(), z.unknown()),
  }),
  summary: z.string(),
  status: z.enum(["ready", "pending"]),
});

const AdDetectionSchema = z.object({
  is_ad: z.boolean(),
  categories: z.array(z.string()),
  elements: z.array(z.string()),
  contacts: z.array(z.string()),
  urls: z.array(z.string()),
  reason: z.string(),
});

const FaceCoordSchema = z.object({
  frame_index: z.number().int().optional(),
  timestamp_seconds: z.number().nonnegative().optional(),
  box: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  }),
  orientation: z.string(),
  confidence: z.number().min(0).max(1),
});

const CoverCandidateSchema = z.object({
  frame_index: z.number().int(),
  timestamp_seconds: z.number().nonnegative(),
  score: z.number().int().min(0).max(100),
  scoring_breakdown: z.record(z.string(), z.number()),
  reason: z.string(),
  is_recommended: z.boolean(),
});

const TrialSchema = z.object({
  trial_start_seconds: z.number().int().nonnegative(),
  trial_end_seconds: z.number().int().nonnegative(),
  trial_score: z.number().min(0).max(1),
  reason: z.string(),
  status: z.enum(["ready", "pending"]),
});

export const REGION_CODES = [
  "japan",
  "china",
  "taiwan",
  "thailand",
  "vietnam",
  "usa",
  "czech",
  "brazil",
  "uk",
  "germany",
  "france",
  "canada",
  "australia",
  "southeast_asia",
  "russia",
  "other",
] as const;

const RegionSchema = z.object({
  code: z.enum(REGION_CODES),
  requested_code: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  signals: z.record(z.string(), z.unknown()),
});

const FrameNoteSchema = z.object({
  frame_index: z.number().int(),
  timestamp_seconds: z.number().nonnegative(),
  summary: z.string(),
});

export const MediaAnalysisOutput = z.object({
  moderation: ModerationSchema,
  tags: TagsSchema,
  ad_detection: AdDetectionSchema,
  face_coordinates: z.array(FaceCoordSchema),
  region: RegionSchema,

  description: z.string().optional(),
  score: z.number().int().min(0).max(100).optional(),
  scoring_breakdown: z.record(z.string(), z.number()).optional(),

  cover_candidates: z.array(CoverCandidateSchema).max(5).optional(),
  trial: TrialSchema.optional(),
  frame_notes: z.array(FrameNoteSchema).optional(),
});

export type MediaAnalysisInputT = z.infer<typeof MediaAnalysisInput>;
export type MediaAnalysisOutputT = z.infer<typeof MediaAnalysisOutput>;

export const MediaAnalysisResponseSchema = {
  type: "object",
  properties: {
    moderation: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approve", "reject", "review"] },
        confidence: { type: "number" },
        summary: { type: "string" },
        violations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              detected: { type: "boolean" },
              confidence: { type: "number" },
              evidence: { type: "string" },
              frame_index: { type: "integer" },
              timestamp_seconds: { type: "number" },
            },
            required: ["category", "detected", "confidence", "evidence"],
          },
        },
      },
      required: ["decision", "confidence", "summary", "violations"],
    },
    tags: {
      type: "object",
      properties: {
        tag_names: { type: "array", items: { type: "string" } },
        extra_tag_names: { type: "array", items: { type: "string" } },
        categories: {
          type: "object",
          properties: {
            meta: { type: "object" },
            appearance: { type: "object" },
            context: { type: "object" },
            production: { type: "object" },
          },
          required: ["meta", "appearance", "context", "production"],
        },
        summary: { type: "string" },
        status: { type: "string", enum: ["ready", "pending"] },
      },
      required: ["tag_names", "extra_tag_names", "categories", "summary", "status"],
    },
    ad_detection: {
      type: "object",
      properties: {
        is_ad: { type: "boolean" },
        categories: { type: "array", items: { type: "string" } },
        elements: { type: "array", items: { type: "string" } },
        contacts: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["is_ad", "categories", "elements", "contacts", "urls", "reason"],
    },
    face_coordinates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          frame_index: { type: "integer" },
          timestamp_seconds: { type: "number" },
          box: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
            required: ["x", "y", "width", "height"],
          },
          orientation: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["box", "orientation", "confidence"],
      },
    },
    region: {
      type: "object",
      properties: {
        code: { type: "string", enum: [...REGION_CODES] },
        requested_code: { type: "string" },
        confidence: { type: "number" },
        reasoning: { type: "string" },
        signals: { type: "object" },
      },
      required: ["code", "requested_code", "confidence", "reasoning", "signals"],
    },
    description: { type: "string" },
    score: { type: "integer" },
    scoring_breakdown: { type: "object" },
    cover_candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          frame_index: { type: "integer" },
          timestamp_seconds: { type: "number" },
          score: { type: "integer" },
          scoring_breakdown: { type: "object" },
          reason: { type: "string" },
          is_recommended: { type: "boolean" },
        },
        required: ["frame_index", "timestamp_seconds", "score", "scoring_breakdown", "reason", "is_recommended"],
      },
    },
    trial: {
      type: "object",
      properties: {
        trial_start_seconds: { type: "integer" },
        trial_end_seconds: { type: "integer" },
        trial_score: { type: "number" },
        reason: { type: "string" },
        status: { type: "string", enum: ["ready", "pending"] },
      },
      required: ["trial_start_seconds", "trial_end_seconds", "trial_score", "reason", "status"],
    },
    frame_notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          frame_index: { type: "integer" },
          timestamp_seconds: { type: "number" },
          summary: { type: "string" },
        },
        required: ["frame_index", "timestamp_seconds", "summary"],
      },
    },
  },
  required: ["moderation", "tags", "ad_detection", "face_coordinates", "region"],
} as const;
