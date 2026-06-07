import { describe, expect, it } from "vitest";
import { resolveAnalyzeRoute, resolveRoute } from "../src/providers/router.ts";

// 2026-06-04 起平台下线 gemini，所有 strategy 退化为 xai/grok-only（无 fallback）。
describe("analyze provider routing · xai-only", () => {
  it("media_analysis → xAI only regardless of strategy", () => {
    expect(resolveAnalyzeRoute("media_analysis", "grok")).toEqual({ primary: "xai", fallback: null });
    expect(resolveAnalyzeRoute("media_analysis", "auto")).toEqual({ primary: "xai", fallback: null });
    expect(resolveAnalyzeRoute("media_analysis", "gemini")).toEqual({ primary: "xai", fallback: null });
  });

  it("media_intro → xAI only regardless of strategy", () => {
    expect(resolveAnalyzeRoute("media_intro", "grok")).toEqual({ primary: "xai", fallback: null });
    expect(resolveAnalyzeRoute("media_intro", "auto")).toEqual({ primary: "xai", fallback: null });
  });
});

describe("moderation provider routing · grok-only", () => {
  it("text biz_types → grok only", () => {
    expect(resolveRoute("comment", "auto")).toEqual({ primary: "grok", fallback: null });
    expect(resolveRoute("nickname", "grok")).toEqual({ primary: "grok", fallback: null });
    expect(resolveRoute("bio", "gemini")).toEqual({ primary: "grok", fallback: null });
  });

  it("avatar → grok-vision (grok-4) instead of gemini", () => {
    expect(resolveRoute("avatar", "auto")).toEqual({ primary: "grok", fallback: null });
  });
});
