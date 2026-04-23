import type { BizType } from "./schema.ts";

export type ProviderStrategy = "auto" | "grok" | "gemini" | "round_robin";

export interface AppConfig {
  id: string;
  name: string;
  secret: string;
  callback_url: string | null;
  biz_types: string[];
  rate_limit_qps: number;
  disabled: boolean;
  provider_strategy: ProviderStrategy;
}

/** Message body enqueued to MODERATION_QUEUE for async execution. */
export interface ModerationJob {
  request_id: string;
  app_id: string;
  biz_type: BizType;
  biz_id: string;
  user_id: string | null;
  content: string;
  callback_url: string;
  extra: Record<string, unknown> | null;
  created_at_ms: number;
}

/** Message body enqueued to CALLBACK_QUEUE. */
export interface CallbackJob {
  request_id: string;
  attempt: number;
}
