import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrokAdapter } from "../src/providers/grok.ts";

function makeEnv(): Env {
  return {
    GROK_API_KEY: "xai-test-key",
    GROK_MODEL: "grok-4-fast-non-reasoning",
    GROK_VISION_MODEL: "grok-4",
  } as unknown as Env;
}

function okResponse(content: object) {
  return new Response(
    JSON.stringify({
      model: "grok-4",
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("grok adapter · post multi-image", () => {
  it("sends one image_url block per url + uses the vision model + post structure suffix", async () => {
    let captured: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return okResponse({
          status: "pass",
          risk_level: "safe",
          categories: [],
          reason: "ok",
          labels: [{ category: "nsfw", detected: true, confidence: 0.9, evidence: "成人内容" }],
        });
      }),
    );

    const adapter = createGrokAdapter(makeEnv());
    const r = await adapter.moderate({
      systemPrompt: "rules",
      content: "标题\n正文",
      isImage: true,
      imageUrls: ["https://b2/0.webp", "https://b2/1.webp", "https://b2/2.webp"],
      timeoutMs: 5000,
    });

    // vision model
    expect(captured.model).toBe("grok-4");
    // system prompt carries the post structure suffix (labels schema)
    expect(captured.messages[0].content).toContain("labels");
    // user content has 3 image_url blocks + the caption text + the instruction
    const blocks = captured.messages[1].content as Array<{ type: string }>;
    const imageBlocks = blocks.filter((b) => b.type === "image_url");
    expect(imageBlocks).toHaveLength(3);
    expect(r.model).toBe("grok-4");
  });

  it("text-only post (no image_urls) uses the cheap text model", async () => {
    let captured: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return okResponse({ status: "pass", risk_level: "safe", categories: [], reason: "ok" });
      }),
    );

    const adapter = createGrokAdapter(makeEnv());
    await adapter.moderate({
      systemPrompt: "rules",
      content: "纯文字帖",
      isImage: false,
      imageUrls: [],
      timeoutMs: 5000,
    });

    expect(captured.model).toBe("grok-4-fast-non-reasoning");
    // plain string user content (no vision blocks)
    expect(typeof captured.messages[1].content).toBe("string");
  });
});
