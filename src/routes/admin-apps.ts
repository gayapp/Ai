import { Hono } from "hono";
import { z } from "zod";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import { bytesToHex } from "../lib/hash.ts";
import {
  getAppById,
  insertApp,
  invalidateAppCache,
  listApps,
  updateAppFields,
  updateAppSecret,
} from "../db/queries.ts";
import { adminActorFromHeaders, logAdminAuditBestEffort } from "../db/admin-audit.ts";
import { ANALYZE_BIZ_TYPES, DELIVERY_MODE } from "../analyze/schema/envelope.ts";
import { BizType } from "../moderation/schema.ts";
import type { AppConfig } from "../moderation/types.ts";

export const adminAppsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminAppsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

const ProviderStrategyEnum = z.enum(["auto", "grok", "gemini", "round_robin"]);
const AnalyzeBizType = z.enum(ANALYZE_BIZ_TYPES);
const DeliveryModeEnum = z.enum(DELIVERY_MODE);

const CreateAppSchema = z.object({
  name: z.string().min(1).max(128),
  callback_url: z.string().url().optional(),
  biz_types: z.array(BizType).default([]),
  analyze_biz_types: z.array(AnalyzeBizType).default([]),
  delivery_mode: DeliveryModeEnum.optional(),
  callback_max_concurrency: z.number().int().min(1).max(100).optional(),
  rate_limit_qps: z.number().int().min(1).max(10_000).optional(),
  provider_strategy: ProviderStrategyEnum.optional(),
}).refine((v) => v.biz_types.length > 0 || v.analyze_biz_types.length > 0, {
  message: "at least one biz_type or analyze_biz_type is required",
});

adminAppsRouter.post("/", async (c) => {
  const body = CreateAppSchema.parse(await c.req.json());
  const defaultQps = parseInt(c.env.DEFAULT_RATE_LIMIT_QPS || "50", 10);
  const id = `app_${randomHex(8)}`;
  const secret = randomHex(32);
  const app: AppConfig = {
    id,
    name: body.name,
    secret,
    callback_url: body.callback_url ?? null,
    biz_types: body.biz_types,
    analyze_biz_types: body.analyze_biz_types,
    delivery_mode: body.delivery_mode ?? "both",
    callback_max_concurrency: body.callback_max_concurrency ?? 10,
    rate_limit_qps: body.rate_limit_qps ?? defaultQps,
    disabled: false,
    provider_strategy: body.provider_strategy ?? "auto",
  };
  await insertApp(c.env.DB, app);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "app.create",
    target_type: "app",
    target_id: id,
    metadata: {
      name: app.name,
      callback_configured: !!app.callback_url,
      biz_types: app.biz_types,
      analyze_biz_types: app.analyze_biz_types,
      delivery_mode: app.delivery_mode,
      callback_max_concurrency: app.callback_max_concurrency,
      rate_limit_qps: app.rate_limit_qps,
      provider_strategy: app.provider_strategy,
    },
  });
  return c.json(
    {
      id,
      name: app.name,
      secret,
      callback_url: app.callback_url,
      biz_types: app.biz_types,
      analyze_biz_types: app.analyze_biz_types,
      delivery_mode: app.delivery_mode,
      callback_max_concurrency: app.callback_max_concurrency,
      rate_limit_qps: app.rate_limit_qps,
      provider_strategy: app.provider_strategy,
      created_at: new Date().toISOString(),
    },
    201,
  );
});

adminAppsRouter.get("/", async (c) => {
  const apps = await listApps(c.env.DB);
  return c.json({
    items: apps.map((a) => ({
      id: a.id,
      name: a.name,
      callback_url: a.callback_url,
      biz_types: a.biz_types,
      analyze_biz_types: a.analyze_biz_types,
      delivery_mode: a.delivery_mode,
      callback_max_concurrency: a.callback_max_concurrency,
      rate_limit_qps: a.rate_limit_qps,
      disabled: a.disabled,
      provider_strategy: a.provider_strategy,
    })),
  });
});

adminAppsRouter.get("/:id", async (c) => {
  const app = await getAppById(c.env.DB, c.req.param("id"));
  if (!app) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  return c.json({
    id: app.id,
    name: app.name,
    callback_url: app.callback_url,
    biz_types: app.biz_types,
    analyze_biz_types: app.analyze_biz_types,
    delivery_mode: app.delivery_mode,
    callback_max_concurrency: app.callback_max_concurrency,
    rate_limit_qps: app.rate_limit_qps,
    disabled: app.disabled,
    provider_strategy: app.provider_strategy,
  });
});

const PatchAppSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  callback_url: z.string().url().nullable().optional(),
  biz_types: z.array(BizType).optional(),
  analyze_biz_types: z.array(AnalyzeBizType).optional(),
  delivery_mode: DeliveryModeEnum.optional(),
  callback_max_concurrency: z.number().int().min(1).max(100).optional(),
  rate_limit_qps: z.number().int().min(1).max(10_000).optional(),
  disabled: z.boolean().optional(),
  provider_strategy: ProviderStrategyEnum.optional(),
});

adminAppsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getAppById(c.env.DB, id);
  if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  const body = PatchAppSchema.parse(await c.req.json());
  const changedFields = Object.keys(body);
  await updateAppFields(c.env.DB, id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.callback_url !== undefined ? { callback_url: body.callback_url ?? null } : {}),
    ...(body.biz_types !== undefined ? { biz_types: body.biz_types } : {}),
    ...(body.analyze_biz_types !== undefined ? { analyze_biz_types: body.analyze_biz_types } : {}),
    ...(body.delivery_mode !== undefined ? { delivery_mode: body.delivery_mode } : {}),
    ...(body.callback_max_concurrency !== undefined ? { callback_max_concurrency: body.callback_max_concurrency } : {}),
    ...(body.rate_limit_qps !== undefined ? { rate_limit_qps: body.rate_limit_qps } : {}),
    ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
    ...(body.provider_strategy !== undefined ? { provider_strategy: body.provider_strategy } : {}),
  });
  await invalidateAppCache(c.env, id);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "app.update",
    target_type: "app",
    target_id: id,
    metadata: {
      changed_fields: changedFields,
      disabled: body.disabled,
      delivery_mode: body.delivery_mode,
      provider_strategy: body.provider_strategy,
      biz_types: body.biz_types,
      analyze_biz_types: body.analyze_biz_types,
      callback_url_changed: body.callback_url !== undefined,
      callback_max_concurrency: body.callback_max_concurrency,
      rate_limit_qps: body.rate_limit_qps,
    },
  });
  return c.json({ ok: true });
});

adminAppsRouter.post("/:id/rotate-secret", async (c) => {
  const id = c.req.param("id");
  const existing = await getAppById(c.env.DB, id);
  if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  const secret = randomHex(32);
  await updateAppSecret(c.env.DB, id, secret);
  await invalidateAppCache(c.env, id);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "app.rotate_secret",
    target_type: "app",
    target_id: id,
    metadata: { name: existing.name },
  });
  return c.json({ id, secret });
});

function randomHex(nBytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return bytesToHex(b);
}
