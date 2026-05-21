import { Hono } from "hono";
import { verifyAdmin } from "../auth/hmac.ts";
import { getCircuitSnapshot } from "../providers/circuit.ts";

export const adminProvidersRouter = new Hono<{ Bindings: Env }>({ strict: false });

adminProvidersRouter.use("*", async (c, next) => {
  verifyAdmin(c.env, c.req.raw.headers, new URL(c.req.url));
  await next();
});

adminProvidersRouter.get("/status", async (c) => {
  const circuits = await getCircuitSnapshot(c.env.NONCE);
  return c.json({
    generated_at: new Date().toISOString(),
    secrets: {
      grok_configured: !!c.env.GROK_API_KEY,
      gemini_configured: !!c.env.GEMINI_API_KEY,
    },
    models: {
      grok: c.env.GROK_MODEL || "grok-4-fast-non-reasoning",
      gemini: c.env.GEMINI_MODEL || "gemini-2.5-flash",
    },
    circuits,
  });
});
