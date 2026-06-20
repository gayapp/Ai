import { describe, expect, it } from "vitest";
import {
  ModelOutput,
  CallbackBody,
  ModerateRequestSchema,
  CachedResult,
  requestIsImage,
} from "../src/moderation/schema.ts";

describe("schema: ModelOutput", () => {
  it("accepts minimal valid object", () => {
    expect(
      ModelOutput.safeParse({ status: "pass", risk_level: "safe" }).success,
    ).toBe(true);
  });

  it("rejects unknown status", () => {
    const r = ModelOutput.safeParse({ status: "banned", risk_level: "safe" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown category (no loose passthrough)", () => {
    const r = ModelOutput.safeParse({
      status: "reject",
      risk_level: "high",
      categories: ["nsfw"],
    });
    expect(r.success).toBe(false);
  });

  it("defaults empty categories and reason", () => {
    const r = ModelOutput.parse({ status: "pass", risk_level: "safe" });
    expect(r.categories).toEqual([]);
    expect(r.reason).toBe("");
  });
});

describe("schema: ModerateRequestSchema", () => {
  it("defaults mode to auto", () => {
    const r = ModerateRequestSchema.parse({
      biz_type: "comment",
      biz_id: "b1",
      content: "hi",
    });
    expect(r.mode).toBe("auto");
  });

  it("rejects empty content", () => {
    expect(
      ModerateRequestSchema.safeParse({
        biz_type: "comment",
        biz_id: "b1",
        content: "",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown biz_type (contract-locked)", () => {
    expect(
      ModerateRequestSchema.safeParse({
        biz_type: "new_type",
        biz_id: "b1",
        content: "hi",
      }).success,
    ).toBe(false);
  });
});

describe("schema: post (multi-image)", () => {
  it("accepts post with content + image_urls", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "post",
      biz_id: "p1",
      content: "标题\n正文",
      image_urls: ["https://b2/0.webp", "https://b2/1.webp"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts image-only post (empty content)", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "post",
      biz_id: "p1",
      content: "",
      image_urls: ["https://b2/0.webp"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects post with neither content nor image_urls", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "post",
      biz_id: "p1",
      content: "   ",
    });
    expect(r.success).toBe(false);
  });

  it("rejects >12 images", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "post",
      biz_id: "p1",
      content: "t",
      image_urls: Array.from({ length: 13 }, (_, i) => `https://b2/${i}.webp`),
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-https image url", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "post",
      biz_id: "p1",
      content: "t",
      image_urls: ["http://b2/0.webp"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects image_urls on a non-post biz_type", () => {
    const r = ModerateRequestSchema.safeParse({
      biz_type: "comment",
      biz_id: "c1",
      content: "hi",
      image_urls: ["https://b2/0.webp"],
    });
    expect(r.success).toBe(false);
  });

  it("ModelOutput accepts labels array", () => {
    const r = ModelOutput.safeParse({
      status: "reject",
      risk_level: "high",
      categories: ["ad"],
      reason: "x",
      labels: [
        { category: "ad", detected: true, confidence: 0.9, evidence: "微信号" },
        { category: "id_document", detected: true, confidence: 0.95, evidence: "第1张图见到身份证" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("requestIsImage: avatar always, post only with images", () => {
    expect(requestIsImage("avatar")).toBe(true);
    expect(requestIsImage("post", ["https://b2/0.webp"])).toBe(true);
    expect(requestIsImage("post", [])).toBe(false);
    expect(requestIsImage("post")).toBe(false);
    expect(requestIsImage("comment")).toBe(false);
  });
});

describe("schema: CallbackBody", () => {
  it("enforces schema_version literal", () => {
    const body = {
      schema_version: "2.0",
      request_id: "x",
      app_id: "a",
      biz_type: "comment",
      biz_id: "b",
      user_id: null,
      status: "pass",
      risk_level: "safe",
      categories: [],
      reason: "",
      provider: "grok",
      model: "grok-2",
      prompt_version: 1,
      cached: false,
      tokens: { input: 1, output: 1 },
      latency_ms: 1,
      created_at: "now",
    };
    expect(CallbackBody.safeParse(body).success).toBe(false);
  });

  it("accepts a well-formed body", () => {
    const body = {
      schema_version: "1.0",
      request_id: "x",
      app_id: "a",
      biz_type: "comment",
      biz_id: "b",
      user_id: null,
      status: "pass",
      risk_level: "safe",
      categories: [],
      reason: "",
      provider: "grok",
      model: "grok-2",
      prompt_version: 1,
      cached: false,
      tokens: { input: 1, output: 1 },
      latency_ms: 1,
      created_at: "now",
    };
    expect(CallbackBody.safeParse(body).success).toBe(true);
  });
});

describe("schema: CachedResult", () => {
  it("accepts error status surprising entries too", () => {
    const r = CachedResult.parse({
      status: "reject",
      risk_level: "medium",
      categories: ["ad"],
      reason: "ads",
      provider: "grok",
      model: "grok-2",
      prompt_version: 7,
    });
    expect(r.categories).toEqual(["ad"]);
  });
});
