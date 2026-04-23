// API 客户端：把 Bearer token 贴到所有请求上。

const TOKEN_KEY = "ai-guard-admin-token";
const BASE_KEY = "ai-guard-admin-base";

export function getApiBase(): string {
  return (
    localStorage.getItem(BASE_KEY) ||
    // 默认用 prod 的自定义域名，开发时可在 Login 页手动覆盖成 localhost
    "https://aicenter-api.1.gay"
  );
}

export function setApiBase(v: string) {
  localStorage.setItem(BASE_KEY, v);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(401, "unauthorized", "未登录");
  const base = getApiBase();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const obj = body as { error_code?: string; message?: string } | null;
    throw new ApiError(
      res.status,
      obj?.error_code ?? "http_error",
      obj?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

// =============================================================
// Typed endpoints
// =============================================================

export type BizType = "comment" | "nickname" | "bio" | "avatar";
export type Provider = "grok" | "gemini";
export type Status = "pass" | "reject" | "review" | "error" | "pending";
export type RiskLevel = "safe" | "low" | "medium" | "high";

export interface AppConfig {
  id: string;
  name: string;
  callback_url: string | null;
  biz_types: string[];
  rate_limit_qps: number;
  disabled: boolean;
}

export interface ModerationRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  status: Status;
  risk_level: RiskLevel | null;
  categories: string[];
  reason: string | null;
  provider: Provider | null;
  model: string | null;
  cached: boolean;
  tokens: { input: number; output: number };
  latency_ms: number;
  created_at: string;
}

export interface PromptRow {
  id: number;
  biz_type: string;
  provider: string;
  version: number;
  content: string;
  is_active: boolean;
  created_by: string | null;
  created_at: number;
}

export interface SummaryData {
  from: string;
  to: string;
  total: number;
  cached: number;
  cache_hit_rate: number;
  by_status: { pass: number; reject: number; review: number; error: number };
  pass_rate: number;
  tokens: { input: number; output: number };
}

export interface CallbackRow {
  request_id: string;
  url: string;
  status_code: number | null;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export const Apps = {
  list: () => api<{ items: AppConfig[] }>("/admin/apps"),
  get: (id: string) => api<AppConfig>(`/admin/apps/${id}`),
  create: (body: { name: string; callback_url?: string; biz_types: string[]; rate_limit_qps?: number }) =>
    api<AppConfig & { secret: string; created_at: string }>("/admin/apps", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (id: string, body: Partial<{ name: string; callback_url: string | null; biz_types: string[]; rate_limit_qps: number; disabled: boolean }>) =>
    api<{ ok: boolean }>(`/admin/apps/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  rotate: (id: string) =>
    api<{ id: string; secret: string }>(`/admin/apps/${id}/rotate-secret`, { method: "POST" }),
};

export const Prompts = {
  list: (biz_type: string, provider: string) =>
    api<{ items: PromptRow[] }>(`/admin/prompts?biz_type=${biz_type}&provider=${provider}`),
  publish: (body: { biz_type: string; provider: string; content: string; created_by?: string }) =>
    api<PromptRow>("/admin/prompts", { method: "POST", body: JSON.stringify(body) }),
  rollback: (id: number) =>
    api<PromptRow>(`/admin/prompts/${id}/rollback`, { method: "POST" }),
  dryRun: (body: { biz_type: string; provider: string; content: string; samples: string[] }) =>
    api<{ results: unknown[] }>("/admin/prompts/dry-run", { method: "POST", body: JSON.stringify(body) }),
};

export const Stats = {
  summary: (q: { from?: string; to?: string; app_id?: string } = {}) =>
    api<SummaryData>(`/admin/stats/summary${qs(q)}`),
  requests: (q: {
    app_id?: string;
    biz_type?: string;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}) => api<{ items: ModerationRow[] }>(`/admin/stats/requests${qs(q)}`),
  request: (id: string) => api<ModerationRow & { prompt_version: number | null; error_code: string | null; extra: unknown; callback_url: string | null; content_hash: string; completed_at: string | null; mode: string; }>(`/admin/stats/requests/${id}`),
  callbacks: (q: { limit?: number; failed?: string } = {}) =>
    api<{ items: CallbackRow[] }>(`/admin/stats/callbacks${qs(q)}`),
  topUsers: (q: { app_id: string; limit?: number; from?: string; to?: string }) =>
    api<{ items: Array<{ user_id: string; rejects: number }> }>(`/admin/stats/top-users${qs(q)}`),
};

export const Alerts = {
  test: () => api<{ sent: boolean; bot_configured: boolean; chat_configured: boolean }>(
    "/admin/alerts/test", { method: "POST" }),
  check: () => api<{ checks: string[]; fired: string[] }>(
    "/admin/alerts/check", { method: "POST" }),
};

function qs(o: Record<string, string | number | undefined>): string {
  const pairs: string[] = [];
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== undefined && v !== "") pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length ? `?${pairs.join("&")}` : "";
}
