import { describe, expect, it } from "vitest";
import { computeContentHash, dedupKey } from "../src/moderation/dedup.ts";

describe("dedup", () => {
  it("content hash stable across whitespace/full-width normalization", async () => {
    const a = await computeContentHash("comment", "  Hello  World  ");
    const b = await computeContentHash("comment", "Hello World");
    expect(a).toBe(b);
  });

  it("content hash differs across biz_type", async () => {
    const a = await computeContentHash("comment", "abc");
    const b = await computeContentHash("nickname", "abc");
    expect(a).not.toBe(b);
  });

  it("dedup key embeds prompt_version and provider", () => {
    const v1 = dedupKey("comment", "grok", 1, "h");
    const v2 = dedupKey("comment", "grok", 2, "h");
    expect(v1).not.toBe(v2);
    expect(v1.startsWith("comment:grok:1:")).toBe(true);
  });

  it("dedup key isolates providers", () => {
    const a = dedupKey("comment", "grok", 5, "h");
    const b = dedupKey("comment", "gemini", 5, "h");
    expect(a).not.toBe(b);
  });
});
