import { AppError, ErrorCodes } from "../lib/errors.ts";
import type { ProviderAdapter, ProviderCallArgs, ProviderResult } from "./router.ts";

const STRUCTURE_SUFFIX =
  `请严格以 JSON 返回：{"status":"pass|reject|review","risk_level":"safe|low|medium|high","categories":["politics"|"porn"|"abuse"|"ad"|"spam"|"violence"|"other"],"reason":"简短原因"}`;

export function createGeminiAdapter(env: Env): ProviderAdapter {
  return {
    id: "gemini",
    async moderate(args: ProviderCallArgs): Promise<ProviderResult> {
      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GEMINI_API_KEY not configured");
      }
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${apiKey}`;

      const parts: unknown[] = [{ text: `${args.systemPrompt}\n\n${STRUCTURE_SUFFIX}` }];

      if (args.isImage) {
        const img = await fetchImageAsInline(args.content, args.timeoutMs);
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
      } else {
        parts.push({ text: `\n\n待审核内容：\n${args.content}` });
      }

      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      };

      const startedAt = Date.now();
      const res = await fetchGeminiWithRetry(url, body, args.timeoutMs);
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await safeText(res);
        // 400 API_KEY_INVALID / 401 / 403 = key 无效 / 被禁 — 升级为 AUTH_FAILED
        const bodyLooksAuth = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|invalid API key/i.test(text);
        if (res.status === 401 || res.status === 403 || (res.status === 400 && bodyLooksAuth)) {
          throw new AppError(
            ErrorCodes.PROVIDER_AUTH_FAILED,
            502,
            `gemini auth failed (http ${res.status})`,
            text.slice(0, 500),
          );
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          formatGeminiHttpError(res.status, text),
          text.slice(0, 500),
        );
      }
      const data = (await res.json()) as GeminiResponse;
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      return {
        rawText,
        model,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs,
      };
    },
  };
}

async function fetchGeminiWithRetry(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "gemini timeout");
      }
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw new AppError(
        ErrorCodes.PROVIDER_ERROR,
        502,
        `gemini fetch: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.status === 429 && attempt < maxAttempts) {
      const text = await res.clone().text().catch(() => "");
      if (isLongQuotaExhausted(text)) return res;
    }
    if (!isRetryableGeminiStatus(res.status) || attempt === maxAttempts) {
      return res;
    }
    await sleep(retryDelayMs(attempt));
  }
  throw new AppError(ErrorCodes.PROVIDER_ERROR, 502, "gemini retry exhausted");
}

function isRetryableGeminiStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isLongQuotaExhausted(text: string): boolean {
  return /generate_requests_per_model_per_day|GenerateRequestsPerDayPerProjectPerModel/i.test(text) ||
    /retryDelay"\s*:\s*"\d{4,}s"/i.test(text);
}

function formatGeminiHttpError(status: number, text: string): string {
  if (status !== 429) return `gemini http ${status}`;
  const metric = text.match(/Quota exceeded for metric:\s*([^,\n]+)/i)?.[1]?.trim();
  const retry = text.match(/Please retry in\s*([^.]+)\./i)?.[1]?.trim() ||
    text.match(/"retryDelay"\s*:\s*"([^"]+)"/i)?.[1]?.trim();
  return [
    "gemini quota/rate limited (http 429)",
    metric ? `metric=${metric}` : null,
    retry ? `retry_in=${retry}` : null,
  ].filter(Boolean).join(", ");
}

function retryDelayMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function fetchImageAsInline(
  url: string,
  timeoutMs: number,
): Promise<{ mimeType: string; base64: string }> {
  if (!/^https?:\/\//.test(url)) {
    throw new AppError(ErrorCodes.UNSUPPORTED_CONTENT, 400, "image content must be http(s) URL");
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (e) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `fetch image failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new AppError(ErrorCodes.UNSUPPORTED_CONTENT, 422, `image ${res.status}`);
  }
  const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim() || "image/jpeg";
  if (!ct.startsWith("image/")) {
    throw new AppError(ErrorCodes.UNSUPPORTED_CONTENT, 422, `not an image: ${ct}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const MAX = 8 * 1024 * 1024;
  if (buf.byteLength > MAX) {
    throw new AppError(ErrorCodes.UNSUPPORTED_CONTENT, 413, "image too large (>8MB)");
  }
  return { mimeType: ct, base64: base64Encode(buf) };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
