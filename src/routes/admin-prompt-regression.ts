import { Hono } from "hono";
import { z } from "zod";
import {
  assertPromptRoute,
  dryRunPrompt,
  PromptBizType,
  PromptProvider,
} from "../admin/prompt-dry-run.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import { adminActorFromHeaders, logAdminAuditBestEffort } from "../db/admin-audit.ts";
import { getActivePrompt } from "../db/queries.ts";
import {
  createPromptRegressionSet,
  getPromptRegressionSet,
  listPromptRegressionSets,
  updatePromptRegressionSet,
  type PromptRegressionSample,
} from "../db/prompt-regression.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";

export const adminPromptRegressionRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminPromptRegressionRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

const RegressionSampleSchema = z.object({
  name: z.string().min(1).max(120),
  input: z.string().min(1).max(20_000),
  expected: z.unknown().optional(),
});

const CreateSetSchema = z.object({
  name: z.string().min(1).max(120),
  biz_type: PromptBizType,
  provider: PromptProvider,
  samples: z.array(RegressionSampleSchema).min(1).max(20),
  created_by: z.string().max(120).optional(),
});

const PatchSetSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  samples: z.array(RegressionSampleSchema).min(1).max(20).optional(),
}).refine((v) => v.name !== undefined || v.samples !== undefined, {
  message: "at least one field is required",
});

const RunSetSchema = z.object({
  draft_content: z.string().min(1).max(20_000),
});

adminPromptRegressionRouter.get("/", async (c) => {
  const bizType = c.req.query("biz_type");
  const provider = c.req.query("provider");
  const limitRaw = c.req.query("limit");
  if (bizType) PromptBizType.parse(bizType);
  if (provider) PromptProvider.parse(provider);
  if (bizType && provider) assertPromptRoute(bizType, provider);
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const items = await listPromptRegressionSets(c.env.DB, {
    bizType: bizType || undefined,
    provider: provider || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return c.json({ items });
});

adminPromptRegressionRouter.post("/", async (c) => {
  const body = CreateSetSchema.parse(await c.req.json());
  assertPromptRoute(body.biz_type, body.provider);
  const actor = adminActorFromHeaders(c.req.raw.headers);
  const row = await createPromptRegressionSet(c.env.DB, {
    name: body.name,
    bizType: body.biz_type,
    provider: body.provider,
    samples: body.samples,
    createdBy: body.created_by ?? actor,
  });
  await logAdminAuditBestEffort(c.env.DB, {
    actor,
    action: "prompt_regression.create",
    target_type: "prompt_regression_set",
    target_id: String(row.id),
    metadata: {
      name: row.name,
      biz_type: row.biz_type,
      provider: row.provider,
      sample_count: row.sample_count,
    },
  });
  return c.json(row, 201);
});

adminPromptRegressionRouter.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const row = await getPromptRegressionSet(c.env.DB, id);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "regression set not found");
  return c.json(row);
});

adminPromptRegressionRouter.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const body = PatchSetSchema.parse(await c.req.json());
  const row = await updatePromptRegressionSet(c.env.DB, id, body);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "regression set not found");
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "prompt_regression.update",
    target_type: "prompt_regression_set",
    target_id: String(row.id),
    metadata: {
      name: row.name,
      biz_type: row.biz_type,
      provider: row.provider,
      sample_count: row.sample_count,
    },
  });
  return c.json(row);
});

adminPromptRegressionRouter.post("/:id/run", async (c) => {
  const id = parseId(c.req.param("id"));
  const body = RunSetSchema.parse(await c.req.json());
  const row = await getPromptRegressionSet(c.env.DB, id);
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 404, "regression set not found");
  assertPromptRoute(row.biz_type, row.provider);
  const active = await getActivePrompt(c.env.DB, row.biz_type, row.provider);
  if (!active) {
    throw new AppError(
      ErrorCodes.NOT_FOUND,
      404,
      `active prompt not found for ${row.biz_type}/${row.provider}`,
    );
  }

  const samples = row.samples.map((sample) => sample.input);
  const [activeResults, draftResults] = await Promise.all([
    dryRunPrompt(c.env, {
      biz_type: PromptBizType.parse(row.biz_type),
      provider: PromptProvider.parse(row.provider),
      content: active.content,
      samples,
    }),
    dryRunPrompt(c.env, {
      biz_type: PromptBizType.parse(row.biz_type),
      provider: PromptProvider.parse(row.provider),
      content: body.draft_content,
      samples,
    }),
  ]);

  const results = row.samples.map((sample, idx) => {
    const activeResult = activeResults[idx] ?? {};
    const draftResult = draftResults[idx] ?? {};
    const changed = stableJson(normalizeComparable(activeResult)) !==
      stableJson(normalizeComparable(draftResult));
    return {
      name: sample.name,
      input: sample.input,
      expected: sample.expected ?? null,
      active: activeResult,
      draft: draftResult,
      changed,
      active_schema_ok: resultSchemaOk(activeResult),
      draft_schema_ok: resultSchemaOk(draftResult),
      active_expected_match: expectedMatch(activeResult, sample),
      draft_expected_match: expectedMatch(draftResult, sample),
    };
  });

  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "prompt_regression.run",
    target_type: "prompt_regression_set",
    target_id: String(row.id),
    metadata: {
      name: row.name,
      biz_type: row.biz_type,
      provider: row.provider,
      sample_count: row.sample_count,
      active_version: active.version,
      draft_length: body.draft_content.length,
    },
  });

  return c.json({
    set_id: row.id,
    name: row.name,
    biz_type: row.biz_type,
    provider: row.provider,
    active_version: active.version,
    sample_count: row.sample_count,
    summary: summarize(results),
    results,
  });
});

function parseId(raw: string): number {
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, "bad id");
  }
  return id;
}

function resultSchemaOk(result: Record<string, unknown>): boolean {
  if (typeof result.schema_ok === "boolean") return result.schema_ok;
  if (typeof result.input_schema_ok === "boolean") return result.input_schema_ok;
  return !("error" in result);
}

function expectedMatch(
  result: Record<string, unknown>,
  sample: PromptRegressionSample,
): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(sample, "expected")) return null;
  return expectedSubsetMatch(normalizeComparable(result), sample.expected);
}

function expectedSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualObj = actual as Record<string, unknown>;
    const expectedObj = expected as Record<string, unknown>;
    return Object.keys(expectedObj).every((key) =>
      expectedSubsetMatch(actualObj[key], expectedObj[key])
    );
  }
  return stableJson(actual) === stableJson(expected);
}

function normalizeComparable(result: Record<string, unknown>): unknown {
  if ("parsed" in result) return result.parsed;
  if ("prompt_preview" in result) return result.prompt_preview;
  if ("rawText" in result) return result.rawText;
  if ("error" in result) return { error: result.error };
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortJson(obj[key]);
    }
    return out;
  }
  return value;
}

function summarize(results: Array<{
  changed: boolean;
  active_schema_ok: boolean;
  draft_schema_ok: boolean;
  active_expected_match: boolean | null;
  draft_expected_match: boolean | null;
}>): Record<string, number> {
  return {
    changed: results.filter((r) => r.changed).length,
    unchanged: results.filter((r) => !r.changed).length,
    active_schema_failures: results.filter((r) => !r.active_schema_ok).length,
    draft_schema_failures: results.filter((r) => !r.draft_schema_ok).length,
    active_expected_failures: results.filter((r) => r.active_expected_match === false).length,
    draft_expected_failures: results.filter((r) => r.draft_expected_match === false).length,
  };
}
