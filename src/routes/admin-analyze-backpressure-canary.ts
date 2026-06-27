import { Hono } from "hono";
import { z } from "zod";
import { ANALYZE_BIZ_TYPES } from "../analyze/schema/envelope.ts";
import {
  BACKPRESSURE_CANARY_DEFAULT_TTL_SECONDS,
  BACKPRESSURE_CANARY_MAX_TTL_SECONDS,
  armBackpressureCanary,
  clearBackpressureCanary,
  getBackpressureCanary,
  type BackpressureCanaryGate,
} from "../analyze/backpressure.ts";
import { verifyAdmin } from "../auth/hmac.ts";
import { adminActorFromHeaders, logAdminAuditBestEffort } from "../db/admin-audit.ts";
import { getAppById } from "../db/queries.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";

export const adminAnalyzeBackpressureCanaryRouter = new Hono<{ Bindings: Env }>({
  strict: false,
});

adminAnalyzeBackpressureCanaryRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers); // 仅头部鉴权（?token= 仅 evidence 路由允许）
  await next();
});

const ArmCanarySchema = z.object({
  app_id: z.string().min(1),
  biz_type: z.enum(ANALYZE_BIZ_TYPES),
  biz_id: z.string().min(1).max(128),
  ttl_seconds: z.number().int().min(1).max(BACKPRESSURE_CANARY_MAX_TTL_SECONDS)
    .default(BACKPRESSURE_CANARY_DEFAULT_TTL_SECONDS),
  reason: z.string().max(256).optional(),
});

adminAnalyzeBackpressureCanaryRouter.post("/", async (c) => {
  const body = ArmCanarySchema.parse(await c.req.json());
  const app = await getAppById(c.env.DB, body.app_id);
  if (!app) throw new AppError(ErrorCodes.NOT_FOUND, 404, "app not found");
  if (!app.analyze_biz_types.includes(body.biz_type)) {
    throw new AppError(
      ErrorCodes.BIZ_TYPE_NOT_ALLOWED,
      403,
      `analyze biz_type '${body.biz_type}' not enabled for this app`,
    );
  }

  const actor = adminActorFromHeaders(c.req.raw.headers);
  const gate = await armBackpressureCanary(c.env, {
    appId: body.app_id,
    bizType: body.biz_type,
    bizId: body.biz_id,
    ttlSeconds: body.ttl_seconds,
    reason: body.reason,
    armedBy: actor,
  });
  await logAdminAuditBestEffort(c.env.DB, {
    actor,
    action: "analyze.backpressure_canary.arm",
    target_type: "app",
    target_id: body.app_id,
    metadata: {
      biz_type: body.biz_type,
      biz_id: body.biz_id,
      ttl_seconds: body.ttl_seconds,
      reason: body.reason ?? null,
    },
  });
  return c.json({ armed: true, gate: formatGate(gate) });
});

adminAnalyzeBackpressureCanaryRouter.get("/", async (c) => {
  const appId = z.string().min(1).parse(c.req.query("app_id"));
  const gate = await getBackpressureCanary(c.env, appId);
  return c.json({ armed: !!gate, gate: gate ? formatGate(gate) : null });
});

adminAnalyzeBackpressureCanaryRouter.delete("/:app_id", async (c) => {
  const appId = c.req.param("app_id");
  await clearBackpressureCanary(c.env, appId);
  await logAdminAuditBestEffort(c.env.DB, {
    actor: adminActorFromHeaders(c.req.raw.headers),
    action: "analyze.backpressure_canary.clear",
    target_type: "app",
    target_id: appId,
    metadata: {},
  });
  return c.json({ ok: true });
});

function formatGate(gate: BackpressureCanaryGate): Record<string, unknown> {
  return {
    app_id: gate.app_id,
    biz_type: gate.biz_type,
    biz_id: gate.biz_id,
    reason: gate.reason,
    armed_by: gate.armed_by,
    armed_at: new Date(gate.armed_at_ms).toISOString(),
    expires_at: new Date(gate.expires_at_ms).toISOString(),
  };
}
