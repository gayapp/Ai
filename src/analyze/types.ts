export type AnalyzeBizType = "media_analysis" | "media_intro";
export type AnalyzeMode = "sync" | "async" | "auto" | "auto-downgraded";
export type AnalyzeStatus = "pending" | "ok" | "error";
export type DeliveryMode = "callback" | "pull" | "both";
export type AnalyzeProvider = "grok" | "gemini" | "xai";

export interface AnalyzeJob {
  request_id: string;
  app_id: string;
  biz_type: AnalyzeBizType;
  created_at_ms: number;
}

export interface AnalyzeRow {
  id: string;
  app_id: string;
  biz_type: string;
  biz_id: string;
  user_id: string | null;
  input_hash: string;
  input_json: string;
  prompt_version: number | null;
  provider: string | null;
  model: string | null;
  mode: string;
  cached: number;
  status: string;
  result_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  error_code: string | null;
  delivery_mode: string | null;
  callback_url: string | null;
  extra_json: string | null;
  delivered_at: number | null;
  acked_at: number | null;
  created_at: number;
  completed_at: number | null;
}
