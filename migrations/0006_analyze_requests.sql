-- 内容服务请求表（与 moderation_requests 分离）
-- 留存策略：input_json 与 result_json 长保留，不参与 TTL（见 RFC §5.4）
CREATE TABLE analyze_requests (
  id               TEXT PRIMARY KEY,         -- UUIDv7
  app_id           TEXT NOT NULL,
  biz_type         TEXT NOT NULL,            -- media_analysis | media_intro | ...
  biz_id           TEXT NOT NULL,
  user_id          TEXT,
  input_hash       TEXT NOT NULL,            -- canonical JSON sha256
  input_json       TEXT NOT NULL,            -- 完整规整化 input（长保留）
  prompt_version   INTEGER,
  provider         TEXT,
  model            TEXT,
  mode             TEXT NOT NULL,            -- sync|async|auto-downgraded
  cached           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,            -- pending|ok|error
  result_json      TEXT,                     -- 完整 result（可能 10KB+，长保留）
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  error_code       TEXT,
  delivery_mode    TEXT,                     -- 'callback' | 'pull' | 'both'（请求级，可覆盖 app 级）
  callback_url     TEXT,                     -- 请求级 callback 覆盖；为空时用 app.callback_url
  extra_json       TEXT,                     -- extra 透传到 callback / 查询结果
  delivered_at     INTEGER,                  -- callback 投递成功时间；pull-only 不写
  acked_at         INTEGER,                  -- pull 模式 ack 时间；callback-only 不写
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_analyze_app_time ON analyze_requests(app_id, created_at);
CREATE INDEX idx_analyze_hash     ON analyze_requests(input_hash, biz_type);
-- 加速 GET /v1/analyze?app_id=...&status=ok&since_id=... cursor 拉取
CREATE INDEX idx_analyze_app_pull ON analyze_requests(app_id, status, acked_at, id);
