/// <reference types="@cloudflare/workers-types" />

import type { AnalyzeJob } from "./analyze/types.ts";
import type { ModerationJob, CallbackJob } from "./moderation/types.ts";

declare global {
  interface Env {
    DB: D1Database;

    DEDUP_CACHE: KVNamespace;
    PROMPTS: KVNamespace;
    APPS: KVNamespace;
    NONCE: KVNamespace;

    MODERATION_QUEUE: Queue<ModerationJob>;
    ANALYZE_QUEUE: Queue<AnalyzeJob>;
    CALLBACK_QUEUE: Queue<CallbackJob>;

    EVIDENCE: R2Bucket;

    GROK_API_KEY: string;
    GEMINI_API_KEY: string;
    ADMIN_TOKEN: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    RESEND_API_KEY?: string;
    ALERT_EMAIL?: string;
    ALERT_EMAIL_FROM?: string;

    SYNC_TIMEOUT_MS: string;
    DEDUP_TTL_SECONDS: string;
    GROK_MODEL: string;
    GROK_MEDIA_MODEL?: string;
    GEMINI_MODEL: string;
    DEFAULT_RATE_LIMIT_QPS: string;
    LOG_LEVEL: string;
    SAVE_EVIDENCE?: string; // "true" 才启用 R2 证据保存
    ALERTS_DISABLED?: string; // "true" 则全平台告警静默（dev 用，避免无真实流量的环境刷告警）
  }
}

export {};
