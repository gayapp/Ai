import { AppError, ErrorCodes } from "../../lib/errors.ts";
import type { MediaAnalysisInputT } from "../schema/media-analysis.ts";

const XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";

export interface XaiMediaResult {
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function callXaiMediaAnalysis(
  env: Env,
  args: {
    prompt: string;
    input: MediaAnalysisInputT;
    timeoutMs: number;
  },
): Promise<XaiMediaResult> {
  const apiKey = env.GROK_API_KEY;
  if (!apiKey) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GROK_API_KEY not configured");
  }
  const model = env.GROK_MEDIA_MODEL || "grok-4";
  const body = {
    model,
    messages: [{
      role: "user",
      content: [
        ...args.input.image_urls.map((imageUrl) => ({
          type: "image_url",
          image_url: { url: imageUrl, detail: "high" },
        })),
        { type: "text", text: args.prompt },
      ],
    }],
    response_format: { type: "json_object" },
    temperature: 0,
    stream: false,
  };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(XAI_CHAT_COMPLETIONS_URL, {
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
      throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "xai media timeout");
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `xai media fetch: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const latencyMs = Date.now() - startedAt;
  if (!res.ok) {
    const text = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        ErrorCodes.PROVIDER_AUTH_FAILED,
        502,
        `xai media auth failed (http ${res.status})`,
        text.slice(0, 500),
      );
    }
    if ((res.status === 400 || res.status === 422) && looksLikeUnsupportedMedia(text)) {
      throw new AppError(
        ErrorCodes.UNSUPPORTED_CONTENT,
        422,
        `xai media unsupported content (http ${res.status})`,
        text.slice(0, 500),
      );
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `xai media http ${res.status}`,
      text.slice(0, 500),
    );
  }

  let data: XaiChatCompletionResponse;
  try {
    data = (await res.json()) as XaiChatCompletionResponse;
  } catch (e) {
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `xai media invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    rawText: extractMessageContent(data.choices?.[0]?.message?.content),
    model: data.model ?? model,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

interface XaiChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function extractMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function looksLikeUnsupportedMedia(text: string): boolean {
  return /image|media|mime|image_url|fetch|retrieve|download|url|uri|unsupported|invalid/i.test(text);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
