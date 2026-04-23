import { hmacSha256Hex } from "../lib/hash.ts";

export async function signCallbackBody(secret: string, rawBody: string): Promise<string> {
  return hmacSha256Hex(secret, rawBody);
}
