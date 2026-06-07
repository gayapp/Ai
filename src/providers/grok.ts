import { AppError, ErrorCodes } from "../lib/errors.ts";
import type { ProviderAdapter, ProviderCallArgs, ProviderResult } from "./router.ts";

const GROK_URL = "https://api.x.ai/v1/chat/completions";

const STRUCTURE_SUFFIX =
  `请严格以 JSON 返回：{"status":"pass|reject|review","risk_level":"safe|low|medium|high","categories":["politics"|"porn"|"abuse"|"ad"|"spam"|"violence"|"other"],"reason":"简短原因"}`;

export function createGrokAdapter(env: Env): ProviderAdapter {
  return {
    id: "grok",
    async moderate(args: ProviderCallArgs): Promise<ProviderResult> {
      const apiKey = env.GROK_API_KEY;
      if (!apiKey) {
        throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GROK_API_KEY not configured");
      }
      // 文本 biz_type 走 fast-non-reasoning；avatar/image 走 vision-capable 模型（默认 grok-4）。
      // GROK_VISION_MODEL 单独配置允许独立调整。
      const textModel = env.GROK_MODEL || "grok-4-fast-non-reasoning";
      const visionModel = (env as { GROK_VISION_MODEL?: string }).GROK_VISION_MODEL || "grok-4";
      const model = args.isImage ? visionModel : textModel;
      const startedAt = Date.now();
      const userContent: unknown = args.isImage
        ? [
            { type: "image_url", image_url: { url: args.content, detail: "high" } },
            { type: "text", text: "Moderate this image per the rules above." },
          ]
        : args.content;
      const body = {
        model,
        messages: [
          { role: "system", content: `${args.systemPrompt}\n\n${STRUCTURE_SUFFIX}` },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      };

      let res: Response;
      try {
        res = await fetch(GROK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(args.timeoutMs),
        });
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "grok timeout");
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `grok fetch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await safeText(res);
        // 401/403 = key 无效 / 被禁 / 没权限 — 升级为 AUTH_FAILED
        if (res.status === 401 || res.status === 403) {
          throw new AppError(
            ErrorCodes.PROVIDER_AUTH_FAILED,
            502,
            `grok auth failed (http ${res.status})`,
            text.slice(0, 500),
          );
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `grok http ${res.status}`,
          text.slice(0, 500),
        );
      }
      const data = (await res.json()) as GrokResponse;
      const rawText = data.choices?.[0]?.message?.content ?? "";
      return {
        rawText,
        model: data.model ?? model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    },
  };
}

interface GrokResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
