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
import {
  assertPromptRoute,
  dryRunPrompt,
  PromptBizType,
  PromptDryRunSchema,
  PromptProvider,
} from "../admin/prompt-dry-run.ts";

export const adminPromptsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminPromptsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

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

adminPromptsRouter.post("/dry-run", async (c) => {
  const body = PromptDryRunSchema.parse(await c.req.json());
  return c.json({ results: await dryRunPrompt(c.env, body) });
});
