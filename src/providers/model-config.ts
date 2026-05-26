import { z } from "zod";

const MODEL_CONFIG_KEY = "provider:model-config:v1";

export const GEMINI_MODEL_OPTIONS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-lite-latest",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
] as const;

export const ProviderModelPatch = z.object({
  gemini: z.enum(GEMINI_MODEL_OPTIONS).optional(),
});

export type ProviderModelPatchT = z.infer<typeof ProviderModelPatch>;

export interface ProviderModelConfig {
  grok: string;
  grok_media: string;
  gemini: string;
  options: {
    gemini: typeof GEMINI_MODEL_OPTIONS;
  };
  source: {
    grok: "env" | "kv";
    grok_media: "env" | "kv";
    gemini: "env" | "kv";
  };
}

interface StoredProviderModels {
  gemini?: string;
}

export async function getProviderModelConfig(env: Env): Promise<ProviderModelConfig> {
  const stored = await readStoredProviderModels(env);
  return {
    grok: env.GROK_MODEL || "grok-4-fast-non-reasoning",
    grok_media: env.GROK_MEDIA_MODEL || "grok-4",
    gemini: stored.gemini || env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    options: {
      gemini: GEMINI_MODEL_OPTIONS,
    },
    source: {
      grok: "env",
      grok_media: "env",
      gemini: stored.gemini ? "kv" : "env",
    },
  };
}

export async function getGeminiModel(env: Env): Promise<string> {
  return (await getProviderModelConfig(env)).gemini;
}

export async function updateProviderModelConfig(
  env: Env,
  patch: ProviderModelPatchT,
): Promise<ProviderModelConfig> {
  const stored = await readStoredProviderModels(env);
  const next: StoredProviderModels = {
    ...stored,
    ...patch,
  };
  await env.APPS.put(MODEL_CONFIG_KEY, JSON.stringify(next));
  return await getProviderModelConfig(env);
}

async function readStoredProviderModels(env: Env): Promise<StoredProviderModels> {
  if (!env.APPS) return {};
  const raw = await env.APPS.get(MODEL_CONFIG_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredProviderModels;
    return ProviderModelPatch.parse(parsed);
  } catch {
    return {};
  }
}
