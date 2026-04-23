/// <reference types="@cloudflare/workers-types" />

import type { ModerationJob, CallbackJob } from "./moderation/types.ts";

declare global {
  interface Env {
    DB: D1Database;

    DEDUP_CACHE: KVNamespace;
    PROMPTS: KVNamespace;
    APPS: KVNamespace;
    NONCE: KVNamespace;

    MODERATION_QUEUE: Queue<ModerationJob>;
    CALLBACK_QUEUE: Queue<CallbackJob>;

    GROK_API_KEY: string;
    GEMINI_API_KEY: string;
    ADMIN_TOKEN: string;

    SYNC_TIMEOUT_MS: string;
    DEDUP_TTL_SECONDS: string;
    GROK_MODEL: string;
    GEMINI_MODEL: string;
    DEFAULT_RATE_LIMIT_QPS: string;
    LOG_LEVEL: string;
  }
}

export {};
