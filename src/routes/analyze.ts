import { Hono } from "hono";
import { enforceRateLimit } from "../auth/rate-limit.ts";
import { verifyAppRequest } from "../auth/hmac.ts";
import { computeInputHash, canonicalJson } from "../analyze/dedup.ts";
import {
  cacheMediaIntro,
  completeMediaIntroError,
  completeMediaIntroOk,
  runMediaIntro,
  type MediaIntroExecutionContext,
} from "../analyze/pipeline/media-intro.ts";
import { AnalyzeRequestEnvelope, type AnalyzeRequestEnvelopeT } from "../analyze/schema/envelope.ts";
import { MediaIntroInput, type MediaIntroInputT } from "../analyze/schema/media-intro.ts";
import type { AnalyzeMode, DeliveryMode } from "../analyze/types.ts";
import { insertAnalyzePending, updateAnalyzeMode } from "../db/analyze-requests.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import { uuidv7 } from "../lib/id.ts";

export const analyzeRouter = new Hono<{ Bindings: Env }>();

analyzeRouter.post("/v1/analyze", async (c) => {
  const rawBody = await c.req.text();
  const app = await verifyAppRequest(c.env, c.req.raw.headers, rawBody);
  await enforceRateLimit(c.env.NONCE, app.id, app.rate_limit_qps);

  let parsed: AnalyzeRequestEnvelopeT;
  try {
    parsed = AnalyzeRequestEnvelope.parse(JSON.parse(rawBody) as unknown);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, msg);
  }

  if (!app.analyze_biz_types.includes(parsed.biz_type)) {
    throw new AppError(
      ErrorCodes.BIZ_TYPE_NOT_ALLOWED,
      403,
      `analyze biz_type '${parsed.biz_type}' not enabled for this app`,
    );
  }

  const mediaIntroInput = parseMediaIntroInputIfNeeded(parsed);
  const deliveryMode = resolveDeliveryMode(app.delivery_mode, parsed.delivery_mode);
  const callbackUrl = parsed.callback_url ?? app.callback_url;
  if ((deliveryMode === "callback" || deliveryMode === "both") && !callbackUrl) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      400,
      "callback or both delivery_mode requires callback_url (on request or on app config)",
    );
  }

  const requestId = uuidv7();
  const mode = resolveAnalyzeMode(parsed);
  const inputJson = canonicalJson(parsed.input);
  const inputHash = await computeInputHash(parsed.input);

  await insertAnalyzePending(c.env.DB, {
    id: requestId,
    app_id: app.id,
    biz_type: parsed.biz_type,
    biz_id: parsed.biz_id,
    user_id: parsed.user_id ?? null,
    input_hash: inputHash,
    input_json: inputJson,
    mode,
    delivery_mode: deliveryMode,
    callback_url: callbackUrl ?? null,
    extra: parsed.extra ?? null,
  });

  if (parsed.biz_type === "media_intro" && mode !== "async") {
    const context: MediaIntroExecutionContext = { provider: null, promptVersion: null };
    const timeoutMs = parseInt(c.env.SYNC_TIMEOUT_MS || "10000", 10);
    try {
      const run = await runMediaIntro(c.env, inputHash, mediaIntroInput!, timeoutMs, context);
      await completeMediaIntroOk(c.env, requestId, run);
      await cacheMediaIntro(c.env, run);
      return c.json({
        request_id: requestId,
        cached: run.cached,
        result: run.output,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCodes.PROVIDER_TIMEOUT && mode === "auto") {
        await updateAnalyzeMode(c.env.DB, requestId, "auto-downgraded");
        await c.env.ANALYZE_QUEUE.send({
          request_id: requestId,
          app_id: app.id,
          biz_type: parsed.biz_type,
          created_at_ms: Date.now(),
        });
        return c.json(
          { request_id: requestId, accepted_at: new Date().toISOString(), downgraded: true },
          202,
        );
      }

      const overrideCode = e instanceof AppError && e.code === ErrorCodes.PROVIDER_TIMEOUT
        ? ErrorCodes.SYNC_TIMEOUT
        : undefined;
      await completeMediaIntroError(c.env, requestId, e, context, overrideCode);
      if (overrideCode) {
        throw new AppError(
          ErrorCodes.SYNC_TIMEOUT,
          504,
          "media_intro sync request timed out; retry with async or auto",
        );
      }
      throw e;
    }
  }

  await c.env.ANALYZE_QUEUE.send({
    request_id: requestId,
    app_id: app.id,
    biz_type: parsed.biz_type,
    created_at_ms: Date.now(),
  });

  return c.json(
    { request_id: requestId, accepted_at: new Date().toISOString() },
    202,
  );
});

function parseMediaIntroInputIfNeeded(parsed: AnalyzeRequestEnvelopeT): MediaIntroInputT | null {
  if (parsed.biz_type !== "media_intro") return null;
  try {
    return MediaIntroInput.parse(parsed.input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(ErrorCodes.INVALID_REQUEST, 400, msg);
  }
}

function resolveAnalyzeMode(parsed: AnalyzeRequestEnvelopeT): AnalyzeMode {
  if (parsed.biz_type === "media_analysis") return "async";
  return parsed.mode;
}

function resolveDeliveryMode(
  appMode: DeliveryMode,
  requested?: DeliveryMode,
): DeliveryMode {
  if (!requested) return appMode;
  if (appMode === "both") return requested;
  if (requested === appMode) return requested;
  throw new AppError(
    ErrorCodes.INVALID_REQUEST,
    400,
    `delivery_mode '${requested}' is not allowed for this app`,
  );
}
