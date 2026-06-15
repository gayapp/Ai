import { normalizeContent, sha256Hex } from "../lib/hash.ts";
import { CachedResult, type CachedResult as CachedResultT, type BizType } from "./schema.ts";

/** Hash is keyed per-biz_type so "cat" as comment vs nickname don't collide.
 *  post 多图：把 image_urls 按原序并入 hash（视频帧顺序有意义）；
 *  无图时输出与旧版逐字节一致，不动现有 comment/nickname/bio/avatar 缓存。 */
export async function computeContentHash(
  bizType: BizType,
  content: string,
  imageUrls?: string[],
): Promise<string> {
  const normalized = normalizeContent(content);
  const imgPart = imageUrls && imageUrls.length ? `\n${imageUrls.join("\n")}` : "";
  return sha256Hex(`${bizType}\n${normalized}${imgPart}`);
}

/** Dedup KV key MUST include prompt_version (prompt 改动自动失效) + provider
 *  (避免 app 切换策略后拿到另一家的 cached 结果). */
export function dedupKey(
  bizType: BizType,
  provider: string,
  promptVersion: number,
  contentHash: string,
): string {
  return `${bizType}:${provider}:${promptVersion}:${contentHash}`;
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
