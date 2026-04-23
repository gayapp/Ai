export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  let buf: BufferSource;
  if (typeof input === "string") {
    buf = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    buf = input;
  } else {
    buf = input;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    out += b[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Normalize content for dedup keying — trim, collapse whitespace, NFKC. */
export function normalizeContent(s: string): string {
  return s.trim().replace(/\s+/g, " ").normalize("NFKC");
}

/** Constant-time comparison for equal-length hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** HMAC-SHA256 → hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}
