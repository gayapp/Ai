/** R2 证据存储：头像审核完成后保存一份图片拷贝，便于合规回查。 */

export interface SavedEvidence {
  key: string;
  bytes: number;
  contentType: string;
}

/**
 * Fetch an image URL, upload to R2, return the object key.
 * Key format: `avatars/{YYYY-MM-DD}/{request_id}.{ext}`
 *
 * Best-effort：任何异常都不抛（只 log），因为证据保存失败不应影响审核结果。
 */
export async function saveAvatarEvidence(
  bucket: R2Bucket,
  requestId: string,
  imageUrl: string,
): Promise<SavedEvidence | null> {
  if (!/^https?:\/\//.test(imageUrl)) return null;
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn("[evidence] fetch failed", res.status, imageUrl);
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim() || "image/jpeg";
    if (!ct.startsWith("image/")) {
      console.warn("[evidence] not an image:", ct);
      return null;
    }
    const bytes = await res.arrayBuffer();
    const MAX = 10 * 1024 * 1024;
    if (bytes.byteLength > MAX) {
      console.warn("[evidence] too large:", bytes.byteLength);
      return null;
    }
    const ext = ct.split("/")[1]!.split(";")[0]!.replace(/[^a-z0-9]/gi, "") || "jpg";
    const date = new Date().toISOString().slice(0, 10);
    const key = `avatars/${date}/${requestId}.${ext}`;
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: ct },
      customMetadata: { request_id: requestId, source_url: imageUrl.slice(0, 500) },
    });
    return { key, bytes: bytes.byteLength, contentType: ct };
  } catch (e) {
    console.warn("[evidence] save failed", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Stream a stored evidence object (admin only, called from HTTP handler). */
export async function readEvidence(bucket: R2Bucket, key: string): Promise<Response> {
  const obj = await bucket.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { status: 200, headers });
}
