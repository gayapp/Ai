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
          throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "gemini timeout");
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `gemini fetch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await safeText(res);
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `gemini http ${res.status}`,
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
