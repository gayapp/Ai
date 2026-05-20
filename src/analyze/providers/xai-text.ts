import { AppError, ErrorCodes } from "../../lib/errors.ts";

const XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";

export interface XaiTextResult {
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function callXaiTextJson(
  env: Env,
  args: {
    prompt: string;
    timeoutMs: number;
  },
): Promise<XaiTextResult> {
  const apiKey = env.GROK_API_KEY;
  if (!apiKey) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GROK_API_KEY not configured");
  }
  const model = env.GROK_MODEL || "grok-4-fast-non-reasoning";
  const body = {
    model,
    messages: [{ role: "user", content: args.prompt }],
    response_format: { type: "json_object" },
    temperature: 0.4,
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
      throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "xai text timeout");
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `xai text fetch: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const latencyMs = Date.now() - startedAt;
  if (!res.ok) {
    const text = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        ErrorCodes.PROVIDER_AUTH_FAILED,
        502,
        `xai text auth failed (http ${res.status})`,
        text.slice(0, 500),
      );
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `xai text http ${res.status}`,
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
      `xai text invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    rawText: data.choices?.[0]?.message?.content ?? "",
    model: data.model ?? model,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

interface XaiChatCompletionResponse {
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
