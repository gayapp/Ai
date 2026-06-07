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

// 2026-06-04 起平台下线 gemini，全链路只走 xAI（Grok 文本 + Grok-4 vision）。
//   - 所有 moderation biz_type（含 avatar）primary=grok，fallback=null
//   - 所有 analyze biz_type primary=xai，fallback=null
//   - strategy="gemini" / "round_robin" 退化为 xai-only（保留枚举值兼容旧 app 配置）
const DEFAULT_ROUTE: Record<BizType, { primary: Provider; fallback: Provider | null }> = {
  comment: { primary: "grok", fallback: null },
  nickname: { primary: "grok", fallback: null },
  bio: { primary: "grok", fallback: null },
  avatar: { primary: "grok", fallback: null }, // grok-4 vision，需 GROK_VISION_MODEL（默认 grok-4）
};

export interface AnalyzeRoute {
  primary: AnalyzeProvider;
  fallback: AnalyzeProvider | null;
}

const DEFAULT_ANALYZE_ROUTE: Record<AnalyzeBizType, AnalyzeRoute> = {
  media_analysis: { primary: "xai", fallback: null },
  media_intro: { primary: "xai", fallback: null },
};

/**
 * Resolve the primary/fallback providers for a request.
 *   平台 2026-06-04 起统一 xai-only，strategy 字段保留但所有取值都解析为 grok-only（无 fallback）。
 *   保留 "auto" / "grok" / "gemini" / "round_robin" 枚举仅为不破坏现有 app 配置 schema。
 */
export function resolveRoute(
  biz: BizType,
  strategy: ProviderStrategy,
): { primary: Provider; fallback: Provider | null } {
  void strategy; // 所有策略统一映射为 grok-only
  return DEFAULT_ROUTE[biz];
}

/** @deprecated 用 resolveRoute(biz, strategy) 替代 */
export function getRoute(biz: BizType): { primary: Provider; fallback: Provider | null } {
  return DEFAULT_ROUTE[biz];
}

export function resolveAnalyzeRoute(
  biz: AnalyzeBizType,
  strategy: ProviderStrategy = "auto",
): AnalyzeRoute {
  void strategy; // 2026-06-04 起 analyze 统一 xai-only
  return DEFAULT_ANALYZE_ROUTE[biz];
}

export function getAdapter(env: Env, provider: Provider): ProviderAdapter {
  switch (provider) {
    case "grok":
      return createGrokAdapter(env);
    case "gemini":
      return createGeminiAdapter(env);
  }
}
