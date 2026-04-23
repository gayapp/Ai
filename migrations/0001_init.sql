-- ai-guard initial schema
-- See docs/01-architecture.md §数据模型

-- Applications
CREATE TABLE IF NOT EXISTS apps (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  secret           TEXT NOT NULL,
  callback_url     TEXT,
  biz_types        TEXT NOT NULL,
  rate_limit_qps   INTEGER NOT NULL DEFAULT 50,
  disabled         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_disabled ON apps(disabled);

-- Prompt versions
CREATE TABLE IF NOT EXISTS prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  version       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(biz_type, provider, version)
);
CREATE INDEX IF NOT EXISTS idx_prompts_active ON prompts(biz_type, provider, is_active);

-- Moderation requests
CREATE TABLE IF NOT EXISTS moderation_requests (
  id               TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL,
  biz_type         TEXT NOT NULL,
  biz_id           TEXT NOT NULL,
  user_id          TEXT,
  content_hash     TEXT NOT NULL,
  prompt_version   INTEGER,
  provider         TEXT,
  model            TEXT,
  mode             TEXT NOT NULL,
  cached           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,
  risk_level       TEXT,
  categories       TEXT,
  reason           TEXT,
  input_tokens     INTEGER DEFAULT 0,
  output_tokens    INTEGER DEFAULT 0,
  latency_ms       INTEGER DEFAULT 0,
  error_code       TEXT,
  extra            TEXT,
  callback_url     TEXT,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_req_app_time ON moderation_requests(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_req_hash     ON moderation_requests(content_hash, biz_type);
CREATE INDEX IF NOT EXISTS idx_req_status   ON moderation_requests(status);

-- Callback deliveries
CREATE TABLE IF NOT EXISTS callback_deliveries (
  request_id     TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  status_code    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  next_retry_at  INTEGER,
  delivered_at   INTEGER,
  created_at     INTEGER NOT NULL
);

-- Stats rollup
CREATE TABLE IF NOT EXISTS stats_rollup (
  period          TEXT NOT NULL,
  period_start    INTEGER NOT NULL,
  app_id          TEXT NOT NULL,
  biz_type        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  count_total     INTEGER NOT NULL DEFAULT 0,
  count_cached    INTEGER NOT NULL DEFAULT 0,
  count_pass      INTEGER NOT NULL DEFAULT 0,
  count_reject    INTEGER NOT NULL DEFAULT 0,
  count_review    INTEGER NOT NULL DEFAULT 0,
  count_error     INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms  INTEGER,
  latency_p95_ms  INTEGER,
  PRIMARY KEY (period, period_start, app_id, biz_type, provider)
);
CREATE INDEX IF NOT EXISTS idx_stats_time ON stats_rollup(period, period_start);

-- Seed default prompts (can be overwritten later via Admin API)
INSERT INTO prompts (biz_type, provider, version, content, is_active, created_by, created_at)
VALUES
  ('comment',  'grok',   1, '你是内容审核助手，判断用户评论是否违规。关注：色情、辱骂他人、政治敏感、广告诱导、刷屏垃圾、暴力威胁。灰色地带给 review。', 1, 'system', strftime('%s','now')*1000),
  ('nickname', 'grok',   1, '你是昵称审核助手。关注：脏话、辱骂、恶意影射、广告联系方式、敏感词。长度一般 1-30 字符，请对极短内容宽容。', 1, 'system', strftime('%s','now')*1000),
  ('bio',      'grok',   1, '你是个人简介审核助手。关注：色情暗示、辱骂、政治敏感、广告引流、涉黄涉赌、暴力威胁。简介通常表达个性，请对幽默/无伤大雅内容宽容。', 1, 'system', strftime('%s','now')*1000),
  ('avatar',   'gemini', 1, '你是图片审核助手。关注：色情、血腥暴力、政治敏感人物/旗帜、广告水印、令人不适的内容。仅头像范畴，对艺术风格/动漫化合理内容宽容。', 1, 'system', strftime('%s','now')*1000),
  ('comment',  'gemini', 1, '你是内容审核助手，判断用户评论是否违规。关注：色情、辱骂他人、政治敏感、广告诱导、刷屏垃圾、暴力威胁。灰色地带给 review。', 0, 'system', strftime('%s','now')*1000),
  ('nickname', 'gemini', 1, '你是昵称审核助手。关注：脏话、辱骂、恶意影射、广告联系方式、敏感词。长度一般 1-30 字符，请对极短内容宽容。', 0, 'system', strftime('%s','now')*1000),
  ('bio',      'gemini', 1, '你是个人简介审核助手。关注：色情暗示、辱骂、政治敏感、广告引流、涉黄涉赌、暴力威胁。', 0, 'system', strftime('%s','now')*1000);
