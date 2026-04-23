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
  SCHEMA_ERROR: "schema_error",
  SYNC_TIMEOUT: "sync_timeout",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

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
    return {
      error_code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function httpError(status: number, code: ErrorCode, message: string, details?: unknown): Response {
  return Response.json(
    { error_code: code, message, ...(details !== undefined ? { details } : {}) },
    { status },
  );
}
