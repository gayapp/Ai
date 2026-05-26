import { AppError, ErrorCodes } from "../../lib/errors.ts";
import { getGeminiModel } from "../../providers/model-config.ts";
import { MediaIntroResponseSchema } from "../schema/media-intro.ts";

export interface GeminiTextResult {
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function callGeminiTextJson(
  env: Env,
  args: {
    prompt: string;
    timeoutMs: number;
  },
): Promise<GeminiTextResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GEMINI_API_KEY not configured");
  }
  const model = await getGeminiModel(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: args.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: MediaIntroResponseSchema,
      temperature: 0.4,
    },
  };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "gemini text timeout");
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `gemini text fetch: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const latencyMs = Date.now() - startedAt;
  if (!res.ok) {
    const text = await safeText(res);
    const bodyLooksAuth = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|invalid API key/i.test(text);
    if (res.status === 401 || res.status === 403 || (res.status === 400 && bodyLooksAuth)) {
      throw new AppError(
        ErrorCodes.PROVIDER_AUTH_FAILED,
        502,
        `gemini text auth failed (http ${res.status})`,
        text.slice(0, 500),
      );
    }
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `gemini text http ${res.status}`,
      text.slice(0, 500),
    );
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch (e) {
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `gemini text invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    rawText: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    model,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    latencyMs,
  };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
