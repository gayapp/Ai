import { AppError, ErrorCodes } from "../../lib/errors.ts";
import { getGeminiModel } from "../../providers/model-config.ts";
import { MediaAnalysisResponseSchema, type MediaAnalysisInputT } from "../schema/media-analysis.ts";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

export interface GeminiMediaResult {
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function callGeminiMediaAnalysis(
  env: Env,
  args: {
    prompt: string;
    input: MediaAnalysisInputT;
    timeoutMs: number;
  },
): Promise<GeminiMediaResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GEMINI_API_KEY not configured");
  }
  const model = await getGeminiModel(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${apiKey}`;

  const startedAt = Date.now();
  const imageParts = await loadInlineImageParts(args.input.image_urls, args.timeoutMs);
  const parts: unknown[] = [
    { text: args.prompt },
    ...imageParts,
  ];

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: MediaAnalysisResponseSchema,
      temperature: 0,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ],
  };

  let res: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "gemini media timeout");
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw new AppError(
        ErrorCodes.PROVIDER_ERROR,
        502,
        `gemini media fetch: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.ok) break;

    const text = await safeText(res);
    const error = classifyGeminiHttpError(res.status, text);
    if (isRetryableHttpStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }
    throw error;
  }

  if (!res) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, 502, "gemini media fetch did not return a response");
  }

  const latencyMs = Date.now() - startedAt;
  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch (e) {
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      502,
      `gemini media invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return {
    rawText,
    model,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    latencyMs,
  };
}

function classifyGeminiHttpError(status: number, text: string): AppError {
  const bodyLooksAuth = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|invalid API key/i.test(text);
  if (status === 401 || status === 403 || (status === 400 && bodyLooksAuth)) {
    return new AppError(
      ErrorCodes.PROVIDER_AUTH_FAILED,
      502,
      `gemini media auth failed (http ${status})`,
      text.slice(0, 500),
    );
  }
  if (status === 400 && looksLikeUnsupportedMedia(text)) {
    return new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `gemini media unsupported content (http ${status})`,
      text.slice(0, 500),
    );
  }
  return new AppError(
    ErrorCodes.PROVIDER_ERROR,
    502,
    `gemini media http ${status}`,
    text.slice(0, 500),
  );
}

function looksLikeUnsupportedMedia(text: string): boolean {
  return /image|media|mime|file[_ ]?uri|file[_ ]?data|fetch|retrieve|download|url|uri|unsupported|invalid argument/i.test(text);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function loadInlineImageParts(
  imageUrls: string[],
  timeoutMs: number,
): Promise<Array<{ inline_data: { mime_type: string; data: string } }>> {
  let totalBytes = 0;
  const parts: Array<{ inline_data: { mime_type: string; data: string } }> = [];
  for (const imageUrl of imageUrls) {
    const image = await fetchImageForInlineData(imageUrl, timeoutMs);
    totalBytes += image.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new AppError(
        ErrorCodes.UNSUPPORTED_CONTENT,
        422,
        `gemini media images exceed total inline size limit ${MAX_TOTAL_IMAGE_BYTES}`,
      );
    }
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: arrayBufferToBase64(image.bytes),
      },
    });
  }
  return parts;
}

async function fetchImageForInlineData(
  imageUrl: string,
  timeoutMs: number,
): Promise<{ mimeType: string; bytes: ArrayBuffer }> {
  let res: Response;
  try {
    res = await fetch(imageUrl, {
      method: "GET",
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "gemini media image fetch timeout");
    }
    throw new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `gemini media image fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `gemini media image fetch http ${res.status}`,
      (await safeText(res)).slice(0, 500),
    );
  }

  const mimeType = normalizeImageMimeType(res.headers.get("content-type"), imageUrl);
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `gemini media image exceeds inline size limit ${MAX_IMAGE_BYTES}`,
    );
  }

  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_CONTENT,
      422,
      `gemini media image size ${bytes.byteLength} is not supported`,
    );
  }
  return { mimeType, bytes };
}

function normalizeImageMimeType(contentType: string | null, imageUrl: string): string {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) return mimeType;
  const guessed = guessImageMimeType(imageUrl);
  if (guessed) return guessed;
  throw new AppError(
    ErrorCodes.UNSUPPORTED_CONTENT,
    422,
    `gemini media URL is not an image; content-type=${contentType ?? "missing"}`,
  );
}

function guessImageMimeType(url: string): string | null {
  const clean = url.split("?")[0]?.toLowerCase() ?? "";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".heic")) return "image/heic";
  if (clean.endsWith(".heif")) return "image/heif";
  return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
