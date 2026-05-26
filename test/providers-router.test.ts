import { describe, expect, it } from "vitest";
import { resolveAnalyzeRoute } from "../src/providers/router.ts";

describe("analyze provider routing", () => {
  it("routes media_analysis to xAI only when strategy is grok", () => {
    expect(resolveAnalyzeRoute("media_analysis", "grok")).toEqual({
      primary: "xai",
      fallback: null,
    });
  });

  it("routes media_intro to xAI only when strategy is grok", () => {
    expect(resolveAnalyzeRoute("media_intro", "grok")).toEqual({
      primary: "xai",
      fallback: null,
    });
  });

  it("routes media_intro to Gemini first when strategy is gemini", () => {
    expect(resolveAnalyzeRoute("media_intro", "gemini")).toEqual({
      primary: "gemini",
      fallback: "xai",
    });
  });
});
