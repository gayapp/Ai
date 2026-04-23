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
import { BizType } from "../moderation/schema.ts";
import type { AppConfig } from "../moderation/types.ts";

export const adminAppsRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminAppsRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers);
  await next();
});

const CreateAppSchema = z.object({
  name: z.string().min(1).max(128),
  callback_url: z.string().url().optional(),
  biz_types: z.array(BizType).min(1),
  rate_limit_qps: z.number().int().min(1).max(10_000).optional(),
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
    rate_limit_qps: body.rate_limit_qps ?? defaultQps,
    disabled: false,
  };
  await insertApp(c.env.DB, app);
  return c.json(
    {
      id,
      name: app.name,
      secret,
      callback_url: app.callback_url,
      biz_types: app.biz_types,
      rate_limit_qps: app.rate_limit_qps,
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
      rate_limit_qps: a.rate_limit_qps,
      disabled: a.disabled,
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
    rate_limit_qps: app.rate_limit_qps,
    disabled: app.disabled,
  });
});

const PatchAppSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  callback_url: z.string().url().nullable().optional(),
  biz_types: z.array(BizType).min(1).optional(),
  rate_limit_qps: z.number().int().min(1).max(10_000).optional(),
  disabled: z.boolean().optional(),
});

adminAppsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getAppById(c.env.DB, id);
  if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  const body = PatchAppSchema.parse(await c.req.json());
  await updateAppFields(c.env.DB, id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.callback_url !== undefined ? { callback_url: body.callback_url ?? null } : {}),
    ...(body.biz_types !== undefined ? { biz_types: body.biz_types } : {}),
    ...(body.rate_limit_qps !== undefined ? { rate_limit_qps: body.rate_limit_qps } : {}),
    ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
  });
  await invalidateAppCache(c.env, id);
  return c.json({ ok: true });
});

adminAppsRouter.post("/:id/rotate-secret", async (c) => {
  const id = c.req.param("id");
  const existing = await getAppById(c.env.DB, id);
  if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  const secret = randomHex(32);
  await updateAppSecret(c.env.DB, id, secret);
  await invalidateAppCache(c.env, id);
  return c.json({ id, secret });
});

function randomHex(nBytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return bytesToHex(b);
}
