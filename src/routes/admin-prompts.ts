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
import { BizType, ModelOutput, Provider } from "../moderation/schema.ts";
import { getAdapter } from "../providers/router.ts";

export const adminPromptsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminPromptsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

adminPromptsRouter.get("/", async (c) => {
  const biz_type = BizType.parse(c.req.query("biz_type"));
  const provider = Provider.parse(c.req.query("provider"));
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
  biz_type: BizType,
  provider: Provider,
  content: z.string().min(1).max(20_000),
  created_by: z.string().optional(),
});

adminPromptsRouter.post("/", async (c) => {
  const body = PublishSchema.parse(await c.req.json());
  const row = await publishPrompt(
    c.env.DB,
    body.biz_type,
    body.provider,
    body.content,
    body.created_by ?? "admin",
  );
  await invalidatePromptCache(c.env, body.biz_type, body.provider);
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
  await invalidatePromptCache(c.env, row.biz_type as "comment" | "nickname" | "bio" | "avatar", row.provider as "grok" | "gemini");
  return c.json({
    id: row.id,
    biz_type: row.biz_type,
    provider: row.provider,
    version: row.version,
    is_active: !!row.is_active,
  });
});

const DryRunSchema = z.object({
  biz_type: BizType,
  provider: Provider,
  content: z.string().min(1),
  samples: z.array(z.string().min(1)).min(1).max(20),
});

adminPromptsRouter.post("/dry-run", async (c) => {
  const body = DryRunSchema.parse(await c.req.json());
  const adapter = getAdapter(c.env, body.provider);
  const isImage = body.biz_type === "avatar";
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
  return c.json({ results });
});
