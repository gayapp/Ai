# 01 · 架构与数据模型

## 总体架构

```
┌───────────────────────────┐          ┌───────────────────────┐
│   各业务应用 (app_xxx)    │          │   管理端 Web UI       │
│  发审核请求 + 收回调      │          │  (Cloudflare Pages)   │
└───────────┬───────────────┘          └───────────┬───────────┘
            │ HTTPS + HMAC                         │ Admin Token
            ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker: ai-guard (主服务)             │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │ Public API │ │ Admin API  │ │ Queue Consumer│ │ Cron    │ │
│  │/v1/moderate│ │/admin/*    │ │ (回调 & 异步) │ │(统计汇总)│ │
│  └─────┬──────┘ └─────┬──────┘ └──────┬───────┘ └────┬────┘ │
│        └──────────┬────────┴──────────┴──────────────┘      │
│                   ▼                                          │
│           ┌───────────────┐   ┌─────────────┐                │
│           │ Moderation    │──▶│ Provider     │  外部 API     │
│           │  Pipeline     │   │  Router      │─▶ Grok        │
│           │ (hash→dedup→  │   │ (grok/gemini│─▶ Gemini       │
│           │  call→parse)  │   │  +熔断)      │                │
│           └───────────────┘   └─────────────┘                │
└──────────┬──────────┬───────────────┬───────────┬───────────┘
           ▼          ▼               ▼           ▼
      ┌─────────┐ ┌─────────┐  ┌───────────┐ ┌──────────┐
      │   D1    │ │   KV    │  │  Queue    │ │ Secrets  │
      │(主数据库)│ │(去重缓存│  │(回调重试) │ │ (API Key)│
      │         │ │ +prompt │  │           │ │          │
      │         │ │ +app)   │  │           │ │          │
      └─────────┘ └─────────┘  └───────────┘ └──────────┘
```

## 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | Cloudflare Workers | 边缘、免运维、冷启动低 |
| 语言 | TypeScript 严格模式 | 类型安全，CF 官方首选 |
| 框架 | Hono | CF Workers 最成熟 HTTP 框架 |
| 校验 | Zod | 请求 + 模型返回双校验 |
| 数据库 | D1 (SQLite) | 关系型，CF 原生 |
| 缓存 | KV（3 个 namespace） | 去重 / prompt / app 配置 |
| 队列 | Cloudflare Queues | 异步回调 + 失败重试 + DLQ |
| 调度 | Cron Triggers | 统计小时/日级汇总 |
| Admin UI | Cloudflare Pages + React + Vite | 独立部署 |
| 包管理 | pnpm | 预留 workspace |
| 部署 | Wrangler 4 | 官方 CLI |

> 刻意不引入 Drizzle / Prisma。D1 schema 简单，原生 SQL + 类型化 helper 更直接，无魔法。

## 关键链路

### 文本审核（同步路径）

```
应用 POST /v1/moderate  ──▶ HMAC 校验
                        ──▶ KV 查 app 配置
                        ──▶ 规范化 content
                        ──▶ 计算 content_hash
                        ──▶ KV 查 dedup cache
                            ├ 命中 ──▶ 写 D1 统计 ──▶ 返回 200 + cached=true
                            └ 未命中
                                  ──▶ KV 取最新 prompt (回源 D1)
                                  ──▶ Provider Router → Grok API
                                  ──▶ Zod 校验模型 JSON
                                  ──▶ 写 D1 requests + results
                                  ──▶ 回写 KV dedup cache
                                  ──▶ 返回 200 + 结果
```

### 自适应降级

同步等待超过 `sync_timeout_ms`（默认 10s）→ Worker 把"生成+回调"任务移交 Queue，**立即响应 202 + request_id**。Queue consumer 完成后通过 HMAC 签名的 webhook 把结果送达应用。

### 图片审核（异步路径）

```
应用 POST /v1/moderate (biz_type=avatar, content=URL)
   ──▶ HMAC 校验 + app 配置
   ──▶ KV 查 dedup（URL hash）
       ├ 命中 ──▶ 200 + cached
       └ 未命中
           ──▶ 202 + request_id
           ──▶ enqueue Moderation Queue
                  │
                  ▼
           Queue Consumer:
              ──▶ 拉取图片 (subrequest)
              ──▶ 计算 image_hash（字节 sha256），再查一次 dedup
              ──▶ 调 Gemini Vision
              ──▶ Zod 校验
              ──▶ 写 D1 + 回写 dedup（URL hash + image hash 两条）
              ──▶ enqueue Callback Queue
                     │
                     ▼
              Callback Dispatcher:
                 ──▶ POST 到 app.callback_url，带 HMAC 签名
                 ──▶ 失败指数退避 5 次后进 DLQ
```

## 数据模型（D1）

```sql
-- 应用
CREATE TABLE apps (
  id               TEXT PRIMARY KEY,           -- app_xxx
  name             TEXT NOT NULL,
  secret_hash      TEXT NOT NULL,              -- Argon2id(secret)
  callback_url     TEXT,
  biz_types        TEXT NOT NULL,              -- JSON array
  rate_limit_qps   INTEGER NOT NULL DEFAULT 50,
  disabled         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- Prompt 版本表
CREATE TABLE prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type      TEXT NOT NULL,
  provider      TEXT NOT NULL,                  -- grok | gemini
  version       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(biz_type, provider, version)
);
CREATE INDEX idx_prompts_active ON prompts(biz_type, provider, is_active);

-- 审核请求 + 结果（合表）
CREATE TABLE moderation_requests (
  id               TEXT PRIMARY KEY,            -- UUIDv7
  app_id           TEXT NOT NULL,
  biz_type         TEXT NOT NULL,
  biz_id           TEXT NOT NULL,
  user_id          TEXT,
  content_hash     TEXT NOT NULL,
  prompt_version   INTEGER,
  provider         TEXT,
  model            TEXT,
  mode             TEXT NOT NULL,               -- sync|async|auto-downgraded
  cached           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,               -- pending|pass|reject|review|error
  risk_level       TEXT,
  categories       TEXT,                        -- JSON
  reason           TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  error_code       TEXT,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_req_app_time ON moderation_requests(app_id, created_at);
CREATE INDEX idx_req_hash     ON moderation_requests(content_hash, biz_type);

-- 回调投递
CREATE TABLE callback_deliveries (
  request_id     TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  status_code    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  next_retry_at  INTEGER,
  delivered_at   INTEGER
);

-- 统计汇总（cron 生成，Admin 查询走这里）
CREATE TABLE stats_rollup (
  period          TEXT NOT NULL,                -- hour|day
  period_start    INTEGER NOT NULL,
  app_id          TEXT NOT NULL,
  biz_type        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  count_total     INTEGER NOT NULL,
  count_cached    INTEGER NOT NULL,
  count_pass      INTEGER NOT NULL,
  count_reject    INTEGER NOT NULL,
  count_review    INTEGER NOT NULL,
  count_error     INTEGER NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  latency_p50_ms  INTEGER,
  latency_p95_ms  INTEGER,
  PRIMARY KEY (period, period_start, app_id, biz_type, provider)
);
```

## KV Namespaces

| Namespace | Key 格式 | Value | TTL | 说明 |
|-----------|---------|-------|-----|------|
| `DEDUP_CACHE` | `{biz_type}:{prompt_version}:{content_hash}` | 结果 JSON | 7d（按 biz_type 可配） | **key 含 prompt_version，prompt 更新自动失效** |
| `PROMPTS` | `{biz_type}:{provider}:active` | `{version, content}` | 60s | 热更新近实时生效 |
| `APPS` | `app:{app_id}` | app 配置子集 | 300s | 免每请求打 D1 |

## Queues

| Queue | Producer | Consumer | 用途 |
|-------|---------|---------|------|
| `MODERATION_QUEUE` | Public API（async 模式 / 降级） | 同 Worker queue handler | 异步执行审核 |
| `CALLBACK_QUEUE` | Pipeline 完成后 / 回调重试 | 同 Worker queue handler | 投递回调，指数退避 |

退避策略：`1min → 5min → 30min → 2h → 12h`，5 次后进 DLQ。

## Secrets（wrangler secret）

- `GROK_API_KEY`
- `GEMINI_API_KEY`
- `HMAC_MASTER`（Admin API 用）
- 每个 app 的密钥**只存 hash**，无法反推明文。

## Provider Router

默认路由（app.provider_strategy = `auto`）：
```
biz_type → 主 provider → 备 provider
comment  → grok        → gemini
nickname → grok        → gemini
bio      → grok        → gemini
avatar   → gemini      → （无，Grok 没 Vision）
```

**每个 app 可独立设置 `provider_strategy`**：

| 策略 | 文本主 → 备 | 头像 |
|------|-------------|------|
| `auto` | grok → gemini | gemini |
| `grok` | grok → gemini | gemini |
| `gemini` | gemini → grok | gemini |
| `round_robin` | 秒切：grok ⇄ gemini | gemini |

**熔断**：provider 连续失败 5 次（60s 窗口）触发熔断 30s，自动切备。状态存 KV，跨边缘生效。

## 部署拓扑

- **Worker** `ai-guard`：fetch + queue + scheduled 三入口。
- **Pages** `ai-guard-admin`：管理 UI，鉴权走 Cloudflare Access 或 Admin Token。
- **绑定**：`DB`（D1）、`DEDUP_CACHE` / `PROMPTS` / `APPS`（KV）、`MODERATION_QUEUE` / `CALLBACK_QUEUE`。
- **Cron**：`0 * * * *` 跑小时统计；`5 0 * * *` 跑日统计与过期数据清理。

## 参考实现

```
src/
├── index.ts              # fetch / queue / scheduled 三入口
├── env.d.ts              # Env bindings 类型
├── routes/               # HTTP 路由
├── moderation/           # pipeline / dedup / schema
├── providers/            # grok / gemini / router
├── callback/             # dispatcher / signer
├── auth/hmac.ts          # HMAC 校验
├── stats/                # counters / rollup
├── db/                   # client / queries
└── lib/                  # hash / errors / id
```
