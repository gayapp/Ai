import { createGrokAdapter } from "./grok.ts";
import { AppError, ErrorCodes } from "../lib/errors.ts";
import type { AnalyzeBizType, AnalyzeProvider } from "../analyze/types.ts";
import type { BizType, Provider } from "../moderation/schema.ts";
import type { ProviderStrategy } from "../moderation/types.ts";

export interface ProviderCallArgs {
  systemPrompt: string;
  content: string; // text or (avatar) single image URL
  isImage: boolean;
  imageUrls?: string[]; // post 多图/视频帧；非空时走 vision，文字放 content
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
  post: { primary: "grok", fallback: null }, // 社区帖：纯文字走文本模型，带图走 grok-4 vision（按请求动态）
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
      // 2026-06-04 起 gemini 全平台下线（见 ai2ai.md）。Provider enum 保留以兼容
      //   历史 moderation_requests 行；但 router 不再路由到 gemini，所以 getAdapter
      //   也不应被请求 gemini。若被请求，明确抛错而非静默退化。
      throw new AppError(
        ErrorCodes.PROVIDER_ERROR,
        500,
        "gemini provider has been retired; route should not reach this adapter",
      );
  }
}
