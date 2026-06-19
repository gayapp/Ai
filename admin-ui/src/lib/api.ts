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

export type BizType = "comment" | "nickname" | "bio" | "avatar" | "post";
export type AnalyzeBizType = "media_analysis" | "media_intro";

export type LabelCategory =
  | "minor_face"
  | "csam"
  | "ad"
  | "drug"
  | "gambling"
  | "politics"
  | "nsfw";

export interface ModerationLabel {
  category: LabelCategory;
  detected: boolean;
  confidence: number;
  evidence: string;
}
export type Provider = "grok" | "gemini" | "xai";
export type Status = "pass" | "reject" | "review" | "error" | "pending";
export type RiskLevel = "safe" | "low" | "medium" | "high";
export type DeliveryMode = "callback" | "pull" | "both";

export type ProviderStrategy = "auto" | "grok" | "gemini" | "round_robin";

export interface AppConfig {
  id: string;
  name: string;
  callback_url: string | null;
  biz_types: string[];
  analyze_biz_types: string[];
  delivery_mode: DeliveryMode;
  callback_max_concurrency: number;
  rate_limit_qps: number;
  disabled: boolean;
  provider_strategy: ProviderStrategy;
}

export interface ModerationRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  content_text?: string | null;
  evidence_key?: string | null;
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

export interface ModerationDetail extends ModerationRow {
  content_hash: string;
  prompt_version: number | null;
  mode: string;
  error_code: string | null;
  extra: Record<string, unknown> | null;
  callback_url: string | null;
  completed_at: string | null;
  image_urls?: string[] | null; // post 多图/视频帧
  labels?: ModerationLabel[] | null; // post 结构化标签
}

export interface ReplayResult {
  original: {
    status: string;
    risk_level: string | null;
    categories: string[];
    reason: string;
    provider: string | null;
    model: string | null;
    prompt_version: number | null;
    latency_ms: number;
  };
  replayed: {
    status: string;
    risk_level: string | null;
    categories: string[];
    reason: string;
    provider: string | null;
    model: string | null;
    prompt_version: number | null;
    latency_ms: number;
    tokens: { input: number; output: number };
    error_code: string | null;
  };
  changed: boolean;
}

export function evidenceUrl(requestId: string): string {
  const t = getToken() ?? "";
  return `${getApiBase()}/admin/stats/evidence/${encodeURIComponent(requestId)}?token=${encodeURIComponent(t)}`;
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
  funnel?: Record<string, number>; // { model: N, low_signal: M, "ad:xxx": K }
}

export interface AnalyzeSummaryData {
  from: string;
  to: string;
  total: number;
  cached: number;
  cache_hit_rate: number;
  by_status: { pending: number; ok: number; error: number };
  ok_rate: number;
  tokens: { input: number; output: number };
  output_bytes_total: number;
}

export interface PercentileData {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface AnalyzeGrayData {
  from: string;
  to: string;
  app_id: string | null;
  sample_limit: number;
  sample_size: number;
  ready_for_next_stage: boolean;
  gates: Record<string, boolean>;
  status: {
    by_status: { pending: number; ok: number; error: number };
    error_rate: number;
    ok_rate: number;
    pending_older_than_5m: number;
  };
  latency_ms: PercentileData;
  tokens: {
    input: PercentileData;
    output: PercentileData;
  };
  baseline: {
    internal_p95_ms: number | null;
    p95_ratio: number | null;
    max_allowed_p95_ms: number | null;
  };
  dedup: {
    cached: number;
    hit_rate: number;
    expected_min_hit_rate: number;
  };
  delivery: {
    callback_undelivered: number;
    pull_unacked: number;
  };
  error_codes: Record<string, number>;
  by_biz_type: Record<string, number>;
}

export interface AnalyzeBacklogBucket {
  total: number;
  older_than_5m: number;
  older_than_30m: number;
  older_than_2h: number;
  oldest_at: string | null;
  age_buckets: {
    lt_5m: number;
    m5_30m: number;
    m30_2h: number;
    gt_2h: number;
  };
}

export interface AnalyzeBacklogData {
  from: string;
  to: string;
  app_id: string | null;
  pending: AnalyzeBacklogBucket;
  pull_unacked: AnalyzeBacklogBucket;
  callback_undelivered: AnalyzeBacklogBucket;
}

export interface AnalyzeRecordRow {
  request_id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  mode: string;
  status: "pending" | "ok" | "error";
  provider: Provider | null;
  model: string | null;
  cached: boolean;
  tokens: { input: number; output: number };
  latency_ms: number;
  error_code: string | null;
  delivery_mode: DeliveryMode;
  delivered_at: string | null;
  acked_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AnalyzeRecordDetail extends AnalyzeRecordRow {
  input_hash: string;
  prompt_version: number | null;
  callback_url: string | null;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
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

export interface ProviderCircuit {
  provider: "grok" | "gemini" | "xai";
  biz_type: string | null;
  failures: number;
  open_until: string | null;
  last_failure_at: string | null;
  state: "closed" | "open" | "half_open";
  seconds_to_close: number;
}

export interface ProviderStatusData {
  generated_at: string;
  secrets: {
    grok_configured: boolean;
    gemini_configured: boolean;
  };
  models: {
    grok: string;
    grok_media: string;
    gemini: string;
  };
  model_options: {
    gemini: string[];
  };
  model_source: {
    grok: "env" | "kv";
    grok_media: "env" | "kv";
    gemini: "env" | "kv";
  };
  circuits: ProviderCircuit[];
}

export interface ProviderHealthData {
  grok: { ok: boolean; reason?: string; raw?: unknown };
  gemini: { ok: boolean; reason?: string };
  fired: string[];
}

export interface AuditLogRow {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface PromptRegressionSample {
  name: string;
  input: string;
  expected?: unknown;
}

export interface PromptRegressionSetSummary {
  id: number;
  name: string;
  biz_type: string;
  provider: string;
  sample_count: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PromptRegressionSet extends PromptRegressionSetSummary {
  samples: PromptRegressionSample[];
}

export interface PromptRegressionRunResult {
  set_id: number;
  name: string;
  biz_type: string;
  provider: string;
  active_version: number;
  sample_count: number;
  summary: Record<string, number>;
  results: Array<{
    name: string;
    input: string;
    expected: unknown | null;
    active: Record<string, unknown>;
    draft: Record<string, unknown>;
    changed: boolean;
    active_schema_ok: boolean;
    draft_schema_ok: boolean;
    active_expected_match: boolean | null;
    draft_expected_match: boolean | null;
  }>;
}

export const Apps = {
  list: () => api<{ items: AppConfig[] }>("/admin/apps"),
  get: (id: string) => api<AppConfig>(`/admin/apps/${id}`),
  create: (body: {
    name: string;
    callback_url?: string;
    biz_types: string[];
    analyze_biz_types?: string[];
    delivery_mode?: DeliveryMode;
    callback_max_concurrency?: number;
    rate_limit_qps?: number;
    provider_strategy?: ProviderStrategy;
  }) =>
    api<AppConfig & { secret: string; created_at: string }>("/admin/apps", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (id: string, body: Partial<{
    name: string;
    callback_url: string | null;
    biz_types: string[];
    analyze_biz_types: string[];
    delivery_mode: DeliveryMode;
    callback_max_concurrency: number;
    rate_limit_qps: number;
    disabled: boolean;
    provider_strategy: ProviderStrategy;
  }>) =>
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
  analyzeSummary: (q: { from?: string; to?: string; app_id?: string } = {}) =>
    api<AnalyzeSummaryData>(`/admin/stats/analyze-summary${qs(q)}`),
  analyzeBacklog: (q: { from?: string; to?: string; app_id?: string } = {}) =>
    api<AnalyzeBacklogData>(`/admin/stats/analyze-backlog${qs(q)}`),
  analyzeGray: (q: {
    from?: string;
    to?: string;
    app_id?: string;
    limit?: number;
    baseline_p95_ms?: number;
  } = {}) =>
    api<AnalyzeGrayData>(`/admin/stats/analyze-gray${qs(q)}`),
  requests: (q: {
    app_id?: string;
    biz_type?: string;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {}) => api<{ items: ModerationRow[]; next_cursor: string | null }>(`/admin/stats/requests${qs(q)}`),
  request: (id: string) => api<ModerationDetail>(`/admin/stats/requests/${id}`),
  replay: (id: string) => api<ReplayResult>(`/admin/stats/requests/${id}/replay`, { method: "POST" }),
  callbacks: (q: { limit?: number; failed?: string } = {}) =>
    api<{ items: CallbackRow[] }>(`/admin/stats/callbacks${qs(q)}`),
  topUsers: (q: { app_id: string; limit?: number; from?: string; to?: string }) =>
    api<{ items: Array<{ user_id: string; rejects: number }> }>(`/admin/stats/top-users${qs(q)}`),
};

export const AnalyzeRecords = {
  list: (q: {
    app_id?: string;
    biz_type?: string;
    biz_id?: string;
    status?: string;
    delivery_mode?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {}) => api<{ items: AnalyzeRecordRow[]; next_cursor: string | null; total: number }>(
    `/admin/analyze-records${qs(q)}`,
  ),
  get: (id: string) => api<AnalyzeRecordDetail>(
    `/admin/analyze-records/${encodeURIComponent(id)}`,
  ),
};

export const Alerts = {
  test: () => api<{ sent: boolean; bot_configured: boolean; chat_configured: boolean }>(
    "/admin/alerts/test", { method: "POST" }),
  check: () => api<{ checks: string[]; fired: string[] }>(
    "/admin/alerts/check", { method: "POST" }),
  providerHealth: () => api<ProviderHealthData>(
    "/admin/alerts/provider-health", { method: "POST" }),
};

export const PromptRegression = {
  list: (q: { biz_type?: string; provider?: string; limit?: number } = {}) =>
    api<{ items: PromptRegressionSetSummary[] }>(`/admin/prompt-regression${qs(q)}`),
  create: (body: {
    name: string;
    biz_type: string;
    provider: string;
    samples: PromptRegressionSample[];
    created_by?: string;
  }) =>
    api<PromptRegressionSet>("/admin/prompt-regression", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  get: (id: number) => api<PromptRegressionSet>(`/admin/prompt-regression/${id}`),
  patch: (id: number, body: Partial<{ name: string; samples: PromptRegressionSample[] }>) =>
    api<PromptRegressionSet>(`/admin/prompt-regression/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  run: (id: number, body: { draft_content: string }) =>
    api<PromptRegressionRunResult>(`/admin/prompt-regression/${id}/run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const Providers = {
  status: () => api<ProviderStatusData>("/admin/providers/status"),
  updateModels: (body: { gemini?: string }) =>
    api<Pick<ProviderStatusData, "models" | "model_options" | "model_source">>(
      "/admin/providers/models",
      { method: "PATCH", body: JSON.stringify(body) },
    ),
};

export const Audit = {
  list: (q: {
    actor?: string;
    action?: string;
    target_type?: string;
    target_id?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: number;
  } = {}) => api<{ items: AuditLogRow[]; next_cursor: number | null }>(
    `/admin/audit${qs(q)}`,
  ),
};

function qs(o: Record<string, string | number | undefined>): string {
  const pairs: string[] = [];
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== undefined && v !== "") pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length ? `?${pairs.join("&")}` : "";
}
