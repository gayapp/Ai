import { createGrokAdapter } from "./grok.ts";
import { createGeminiAdapter } from "./gemini.ts";
import type { BizType, Provider } from "../moderation/schema.ts";

export interface ProviderCallArgs {
  systemPrompt: string;
  content: string; // text or image URL
  isImage: boolean;
  timeoutMs: number;
}

export interface ProviderResult {
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ProviderAdapter {
  id: Provider;
  moderate(args: ProviderCallArgs): Promise<ProviderResult>;
}

const ROUTE: Record<BizType, { primary: Provider; fallback: Provider | null }> = {
  comment: { primary: "grok", fallback: "gemini" },
  nickname: { primary: "grok", fallback: "gemini" },
  bio: { primary: "grok", fallback: "gemini" },
  avatar: { primary: "gemini", fallback: null }, // image → Gemini only (Grok text fallback useless)
};

export function getRoute(biz: BizType): { primary: Provider; fallback: Provider | null } {
  return ROUTE[biz];
}

export function getAdapter(env: Env, provider: Provider): ProviderAdapter {
  switch (provider) {
    case "grok":
      return createGrokAdapter(env);
    case "gemini":
      return createGeminiAdapter(env);
  }
}
