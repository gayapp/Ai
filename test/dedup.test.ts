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

  // ---- post 多图：image_urls 并入 hash ----
  it("post: image_urls change the hash", async () => {
    const noImg = await computeContentHash("post", "标题");
    const withImg = await computeContentHash("post", "标题", ["https://x/1.webp"]);
    expect(noImg).not.toBe(withImg);
  });

  it("post: image_urls order is significant (video frame order)", async () => {
    const ab = await computeContentHash("post", "t", ["https://x/a", "https://x/b"]);
    const ba = await computeContentHash("post", "t", ["https://x/b", "https://x/a"]);
    expect(ab).not.toBe(ba);
  });

  it("no-image hash is byte-identical to the legacy 3-arg form (no cache pollution)", async () => {
    const legacy = await computeContentHash("comment", "abc");
    const emptyImgs = await computeContentHash("comment", "abc", []);
    const undefImgs = await computeContentHash("comment", "abc", undefined);
    expect(emptyImgs).toBe(legacy);
    expect(undefImgs).toBe(legacy);
  });
});
