export const ErrorCodes = {
  INVALID_REQUEST: "invalid_request",
  BAD_SIGNATURE: "bad_signature",
  EXPIRED_TIMESTAMP: "expired_timestamp",
  REPLAY_NONCE: "replay_nonce",
  BIZ_TYPE_NOT_ALLOWED: "biz_type_not_allowed",
  APP_NOT_FOUND: "app_not_found",
  APP_DISABLED: "app_disabled",
  UNSUPPORTED_CONTENT: "unsupported_content",
  RATE_LIMITED: "rate_limited",
  PROVIDER_ERROR: "provider_error",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_AUTH_FAILED: "provider_auth_failed",
  SERVICE_UNAVAILABLE: "service_unavailable",
  BACKLOG_OVERLOAD: "backlog_overload",
  SCHEMA_ERROR: "schema_error",
  SCHEMA_VALIDATION_FAILED: "schema_validation_failed",
  SYNC_TIMEOUT: "sync_timeout",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// 只有这些键允许回传客户端。其余（尤其 provider 上游错误体 `body`，实测含
// xAI 的 API key ID / Team ID 等敏感信息）一律丢弃，避免通过错误响应泄漏。
// 全量内部细节仍保留在 AppError.details（进程内用，如归因）并由服务端日志记录。
const PUBLIC_DETAIL_KEYS = new Set(["provider", "retry_after_seconds", "retry_after"]);

/** 把任意 details 过滤为仅含安全白名单键的对象；无安全键则返回 undefined。 */
export function publicDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (PUBLIC_DETAIL_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "AppError";
  }

  toJSON() {
    const pub = publicDetails(this.details);
    return {
      error_code: this.code,
      message: this.message,
      ...(pub !== undefined ? { details: pub } : {}),
    };
  }
}

export function httpError(status: number, code: ErrorCode, message: string, details?: unknown): Response {
  const pub = publicDetails(details);
  return Response.json(
    { error_code: code, message, ...(pub !== undefined ? { details: pub } : {}) },
    { status },
  );
}
