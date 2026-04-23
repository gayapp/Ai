import { normalizeContent, sha256Hex } from "../lib/hash.ts";
import { CachedResult, type CachedResult as CachedResultT, type BizType } from "./schema.ts";

/** Hash is keyed per-biz_type so "cat" as comment vs nickname don't collide. */
export async function computeContentHash(bizType: BizType, content: string): Promise<string> {
  const normalized = normalizeContent(content);
  return sha256Hex(`${bizType}\n${normalized}`);
}

/** Dedup KV key MUST include prompt_version, so prompt changes auto-invalidate. */
export function dedupKey(bizType: BizType, promptVersion: number, contentHash: string): string {
  return `${bizType}:${promptVersion}:${contentHash}`;
}

export async function getDedup(
  kv: KVNamespace,
  key: string,
): Promise<CachedResultT | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  const parsed = CachedResult.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function putDedup(
  kv: KVNamespace,
  key: string,
  value: CachedResultT,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}
