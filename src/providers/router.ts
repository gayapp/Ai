import { createGrokAdapter } from "./grok.ts";
import { createGeminiAdapter } from "./gemini.ts";
import type { AnalyzeBizType, AnalyzeProvider } from "../analyze/types.ts";
import type { BizType, Provider } from "../moderation/schema.ts";
import type { ProviderStrategy } from "../moderation/types.ts";

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

const DEFAULT_ROUTE: Record<BizType, { primary: Provider; fallback: Provider | null }> = {
  comment: { primary: "grok", fallback: "gemini" },
  nickname: { primary: "grok", fallback: "gemini" },
  bio: { primary: "grok", fallback: "gemini" },
  avatar: { primary: "gemini", fallback: null }, // image → Gemini only (Grok text fallback useless)
};

export interface AnalyzeRoute {
  primary: AnalyzeProvider;
  fallback: AnalyzeProvider | null;
}

const DEFAULT_ANALYZE_ROUTE: Record<AnalyzeBizType, AnalyzeRoute> = {
  media_analysis: { primary: "gemini", fallback: "xai" },
  media_intro: { primary: "xai", fallback: "gemini" },
};

/**
 * Resolve the primary/fallback providers for a request.
 *  - avatar 永远用 gemini（Grok 无 Vision，strategy 无视）
 *  - 文本类根据 app.provider_strategy 决定：
 *      auto         → 平台默认（grok 主、gemini 备）
 *      grok         → grok 主、gemini 备
 *      gemini       → gemini 主、grok 备
 *      round_robin  → 基于 Date.now() 奇偶切换主；另一家当备
 */
export function resolveRoute(
  biz: BizType,
  strategy: ProviderStrategy,
): { primary: Provider; fallback: Provider | null } {
  if (biz === "avatar") return DEFAULT_ROUTE.avatar;
  switch (strategy) {
    case "grok":
      return { primary: "grok", fallback: "gemini" };
    case "gemini":
      return { primary: "gemini", fallback: "grok" };
    case "round_robin": {
      const primary: Provider = (Math.floor(Date.now() / 1000) % 2 === 0) ? "grok" : "gemini";
      const fallback: Provider = primary === "grok" ? "gemini" : "grok";
      return { primary, fallback };
    }
    case "auto":
    default:
      return DEFAULT_ROUTE[biz];
  }
}

/** @deprecated 用 resolveRoute(biz, strategy) 替代 */
export function getRoute(biz: BizType): { primary: Provider; fallback: Provider | null } {
  return DEFAULT_ROUTE[biz];
}

export function resolveAnalyzeRoute(
  biz: AnalyzeBizType,
  strategy: ProviderStrategy = "auto",
): AnalyzeRoute {
  const route = DEFAULT_ANALYZE_ROUTE[biz];
  switch (strategy) {
    case "gemini":
      return {
        primary: "gemini",
        fallback: route.primary === "gemini" ? route.fallback : route.primary,
      };
    case "grok":
      return {
        primary: "xai",
        fallback: route.primary === "xai" ? route.fallback : route.primary,
      };
    case "round_robin": {
      const primary: AnalyzeProvider = (Math.floor(Date.now() / 1000) % 2 === 0)
        ? "xai"
        : "gemini";
      const fallback: AnalyzeProvider = primary === "xai" ? "gemini" : "xai";
      return { primary, fallback };
    }
    case "auto":
    default:
      return route;
  }
}

export function getAdapter(env: Env, provider: Provider): ProviderAdapter {
  switch (provider) {
    case "grok":
      return createGrokAdapter(env);
    case "gemini":
      return createGeminiAdapter(env);
  }
}
