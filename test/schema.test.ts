import { describe, expect, it } from "vitest";
import {
  ModelOutput,
  CallbackBody,
  ModerateRequestSchema,
  CachedResult,
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
