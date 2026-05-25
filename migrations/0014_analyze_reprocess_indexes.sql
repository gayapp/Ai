CREATE INDEX IF NOT EXISTS idx_analyze_reprocess_filter
  ON analyze_requests(app_id, status, error_code, id);

CREATE INDEX IF NOT EXISTS idx_analyze_reprocess_biz_latest
  ON analyze_requests(app_id, biz_type, biz_id, status, created_at);
