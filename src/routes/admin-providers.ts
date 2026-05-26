import { Hono } from "hono";
import { verifyAdmin } from "../auth/hmac.ts";
import { getCircuitSnapshot } from "../providers/circuit.ts";
import {
  getProviderModelConfig,
  ProviderModelPatch,
  updateProviderModelConfig,
} from "../providers/model-config.ts";

export const adminProvidersRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminProvidersRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers, new URL(c.req.url));
  await next();
});

adminProvidersRouter.get("/status", async (c) => {
  const [circuits, modelConfig] = await Promise.all([
    getCircuitSnapshot(c.env.NONCE),
    getProviderModelConfig(c.env),
  ]);
  return c.json({
    generated_at: new Date().toISOString(),
    secrets: {
      grok_configured: !!c.env.GROK_API_KEY,
      gemini_configured: !!c.env.GEMINI_API_KEY,
    },
    models: {
      grok: modelConfig.grok,
      grok_media: modelConfig.grok_media,
      gemini: modelConfig.gemini,
    },
    model_options: modelConfig.options,
    model_source: modelConfig.source,
    circuits,
  });
});

adminProvidersRouter.patch("/models", async (c) => {
  const body = ProviderModelPatch.parse(await c.req.json().catch(() => ({})));
  const modelConfig = await updateProviderModelConfig(c.env, body);
  return c.json({
    models: {
      grok: modelConfig.grok,
      grok_media: modelConfig.grok_media,
      gemini: modelConfig.gemini,
    },
    model_options: modelConfig.options,
    model_source: modelConfig.source,
  });
});
