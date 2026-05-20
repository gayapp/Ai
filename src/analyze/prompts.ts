import type { AnalyzeBizType, AnalyzeProvider } from "./types.ts";

const PROMPT_KV_TTL = 60;

export async function loadActiveAnalyzePromptCached(
  env: Env,
  bizType: AnalyzeBizType,
  provider: AnalyzeProvider,
): Promise<{ version: number; content: string } | null> {
  const key = `${bizType}:${provider}:active`;
  const cached = await env.PROMPTS.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as { version: number; content: string };
    } catch {
      // reload from D1
    }
  }
  const row = await env.DB
    .prepare(
      `SELECT version, content FROM prompts WHERE biz_type = ? AND provider = ? AND is_active = 1 LIMIT 1`,
    )
    .bind(bizType, provider)
    .first<{ version: number; content: string }>();
  if (row) {
    await env.PROMPTS.put(key, JSON.stringify(row), { expirationTtl: PROMPT_KV_TTL });
  }
  return row ?? null;
}
