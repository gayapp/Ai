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

  it("dedup key embeds prompt_version", () => {
    const v1 = dedupKey("comment", 1, "h");
    const v2 = dedupKey("comment", 2, "h");
    expect(v1).not.toBe(v2);
    expect(v1.startsWith("comment:1:")).toBe(true);
  });
});
