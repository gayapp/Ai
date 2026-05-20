import { sha256Hex } from "../lib/hash.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function computeInputHash(input: Record<string, unknown>): Promise<string> {
  return await sha256Hex(canonicalJson(input));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}
