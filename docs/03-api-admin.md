# 03 · Admin API（管理端）

面向运营 / 运维。所有接口路径前缀 `/admin/*`，鉴权走 Bearer Token + Cloudflare Access 二选一（由 [wrangler.toml](../wrangler.toml) 配置）。

## 鉴权

```
Authorization: Bearer <ADMIN_TOKEN>
```

`ADMIN_TOKEN` 来自 wrangler secret `HMAC_MASTER`（或单独的 `ADMIN_TOKEN` secret）。生产推荐叠加 Cloudflare Access 做 SSO，`Authorization` 仅作为兜底。

---

## Apps（应用管理）

### `POST /admin/apps` — 创建 app

**Request**
```json
{
  "name": "my-forum",
  "callback_url": "https://myapp.com/hooks/moderate",
  "biz_types": ["comment", "nickname", "bio"],
  "analyze_biz_types": [],
  "delivery_mode": "both",
  "callback_max_concurrency": 10,
  "rate_limit_qps": 100,
  "provider_strategy": "auto"
}
```

### `provider_strategy` 取值

| 值 | moderate 文本 | moderate 头像 | analyze | 说明 |
|----|-------------|------|------|------|
| `auto`（默认） | Grok | Gemini | 按 analyze 默认路由选择 xAI / Gemini | 平台默认路由 |
| `grok` | Grok | Gemini | xAI / Grok only，无 Gemini fallback | IRC 等只允许 xAI 的 analyze app 使用；xAI 故障时保持 pending 等重试 |
| `gemini` | Gemini | Gemini | Gemini 优先，失败按 analyze fallback | 所有可用场景尽量优先 Gemini |
| `round_robin` | 每秒切换 | Gemini | xAI / Gemini 轮换 | 基于 `Date.now()/1000 % 2` 决定本次主 |

> 说明：头像（avatar）因 Grok 无 Vision 能力，无论策略是什么都走 Gemini。analyze 线 provider 取值是 `xai` / `gemini`。

### `delivery_mode` 取值

仅 analyze 线使用：

| 值 | 行为 |
| --- | --- |
| `callback` | 完成后只投递 callback |
| `pull` | 完成后只等待接入方 pull |
| `both`（默认） | callback + pull 兜底，IRC 推荐 |

**Response 201**
```json
{
  "id": "app_7f3a2c8d",
  "name": "my-forum",
  "secret": "only-shown-once-please-save-it",
  "callback_url": "https://myapp.com/hooks/moderate",
  "biz_types": ["comment", "nickname", "bio"],
  "analyze_biz_types": [],
  "delivery_mode": "both",
  "callback_max_concurrency": 10,
  "rate_limit_qps": 100,
  "provider_strategy": "auto",
  "created_at": "2026-04-23T08:00:00Z"
}
```

> ⚠️ `secret` **仅此次明文返回**。后端只存 Argon2id hash。

### `GET /admin/apps` — 列出

**Query**：`?limit=50&cursor=...`

### `GET /admin/apps/{id}`

### `PATCH /admin/apps/{id}`
可更新：

- `name`
- `callback_url`
- `biz_types`
- `analyze_biz_types`
- `delivery_mode`
- `callback_max_concurrency`
- `rate_limit_qps`
- `disabled`
- `provider_strategy`

### `POST /admin/apps/{id}/rotate-secret` — 轮换密钥

旧密钥立即失效（KV 失效 + D1 更新 hash）。新密钥同样只返回一次。

### `DELETE /admin/apps/{id}`
软删除（`disabled=1`）。历史审核记录保留。

---

## Prompts（prompt 热更新）

### `GET /admin/prompts?biz_type=comment&provider=grok`
返回该 biz_type + provider 的所有版本。

**Response**
```json
{
  "items": [
    { "id": 14, "version": 7, "is_active": true, "content": "...", "created_at": "..." },
    { "id": 13, "version": 6, "is_active": false, "content": "...", "created_at": "..." }
  ]
}
```

### `POST /admin/prompts` — 发布新版本

**Request**
```json
{
  "biz_type": "comment",
  "provider": "grok",
  "content": "完整 prompt 文本"
}
```

**语义**：
1. 在同 `(biz_type, provider)` 下取最大 `version + 1` 作为新版本。
2. 默认立即激活，把其他版本 `is_active=0`。
3. 自动清理 `PROMPTS` KV（TTL 60s，1 分钟内全边缘生效）。
4. 新版本 **不会清 `DEDUP_CACHE`**——由于 dedup key 内嵌 `prompt_version`，老缓存自然进入冷处理。

### `POST /admin/prompts/{id}/rollback`
激活指定历史版本。

### `POST /admin/prompts/{id}/test` — 干跑
在不改数据库的情况下用给定 prompt 跑一段测试文本，返回模型原始输出 + Zod 校验结果。用于 [.claude/skills/tune-prompt/](../.claude/skills/tune-prompt/SKILL.md) 工作流。

### `POST /admin/prompts/dry-run` — prompt 干跑

**Request**

```json
{
  "biz_type": "media_intro",
  "provider": "xai",
  "content": "完整 prompt 文本",
  "samples": [
    "{\"title\":\"Sample clip\",\"duration_seconds\":120,\"style_hint\":\"concise\"}"
  ]
}
```

支持范围：

| biz_type | provider | 行为 |
| --- | --- | --- |
| `comment` / `nickname` / `bio` / `avatar` | `grok` / `gemini` | 真实请求 moderate provider，校验 moderate 输出 schema |
| `media_intro` | `xai` / `gemini` | 真实请求 text provider，校验 `MediaIntroOutput` |
| `media_analysis` | `xai` / `gemini` | 只校验 `MediaAnalysisInput` 并返回 prompt preview；不下载图片、不请求多模态 provider |

`media_intro` / `media_analysis` 的 `samples` 需要是一行一个 JSON input object。

---

## Prompt Regression Sets

用于发布 prompt 前固定样本回归。详见 [18-prompt-regression-sets.md](18-prompt-regression-sets.md)。

### `GET /admin/prompt-regression`

Query：`biz_type`、`provider`、`limit`。

返回样本集摘要：

```json
{
  "items": [
    {
      "id": 1,
      "name": "IRC media_analysis regression",
      "biz_type": "media_analysis",
      "provider": "xai",
      "sample_count": 3,
      "created_by": "admin",
      "created_at": 1780000000000,
      "updated_at": 1780000000000
    }
  ]
}
```

### `POST /admin/prompt-regression`

创建样本集。

```json
{
  "name": "IRC media_analysis regression",
  "biz_type": "media_analysis",
  "provider": "xai",
  "samples": [
    {
      "name": "single image",
      "input": "{\"image_urls\":[\"https://example.com/frame.jpg\"]}"
    }
  ]
}
```

### `GET /admin/prompt-regression/{id}`

返回样本集详情。

### `PATCH /admin/prompt-regression/{id}`

可更新 `name`、`samples`。

### `POST /admin/prompt-regression/{id}/run`

用当前 active prompt 与请求中的 draft prompt 分别跑同一组样本。

```json
{
  "draft_content": "完整 draft prompt"
}
```

返回包含 `active_version`、`summary`、每条样本的 `active` / `draft` dry-run 结果、`changed`、schema 校验结果和可选 expected 匹配结果。

---

## Stats（统计）

### `GET /admin/stats/summary`

**Query**：`?period=day&from=2026-04-16&to=2026-04-23&app_id=app_7f3a2c8d`

**Response**
```json
{
  "total": 123456,
  "cached": 45678,
  "cache_hit_rate": 0.37,
  "by_status": { "pass": 110000, "reject": 11000, "review": 2000, "error": 456 },
  "tokens": { "input": 12345678, "output": 2345678 },
  "latency": { "p50": 1200, "p95": 4500 }
}
```

### `GET /admin/stats/analyze-summary`

**Query**：`?from=2026-05-21T00:00:00Z&to=2026-05-22T00:00:00Z&app_id=app_xxx`

返回 analyze 线汇总：

```json
{
  "total": 100,
  "cached": 35,
  "cache_hit_rate": 0.35,
  "by_status": { "pending": 0, "ok": 98, "error": 2 },
  "ok_rate": 0.98,
  "tokens": { "input": 12345, "output": 6789 },
  "output_bytes_total": 456789
}
```

### `GET /admin/stats/analyze-gray`

**Query**：`?from=&to=&app_id=&baseline_p95_ms=15000&limit=10000`

用于 IRC / analyze 灰度升档门禁。

```json
{
  "sample_size": 1000,
  "ready_for_next_stage": true,
  "gates": {
    "has_samples": true,
    "error_rate_under_1_percent": true,
    "no_pending_older_than_5m": true,
    "dedup_hit_rate_at_least_30_percent": true,
    "latency_within_1_5x_baseline": true
  },
  "status": {
    "by_status": { "pending": 0, "ok": 998, "error": 2 },
    "error_rate": 0.002,
    "ok_rate": 0.998,
    "pending_older_than_5m": 0
  },
  "delivery": { "callback_undelivered": 0, "pull_unacked": 0 }
}
```

### `GET /admin/stats/analyze-backlog`

**Query**：`?from=&to=&app_id=`

返回 analyze 交付积压统计，按年龄桶拆分：

```json
{
  "pending": {
    "total": 1,
    "older_than_5m": 0,
    "oldest_at": "2026-05-22T00:00:00.000Z",
    "age_buckets": { "lt_5m": 1, "m5_30m": 0, "m30_2h": 0, "gt_2h": 0 }
  },
  "pull_unacked": {
    "total": 0,
    "older_than_5m": 0,
    "oldest_at": null,
    "age_buckets": { "lt_5m": 0, "m5_30m": 0, "m30_2h": 0, "gt_2h": 0 }
  },
  "callback_undelivered": {
    "total": 0,
    "older_than_5m": 0,
    "oldest_at": null,
    "age_buckets": { "lt_5m": 0, "m5_30m": 0, "m30_2h": 0, "gt_2h": 0 }
  }
}
```

### `GET /admin/stats/top-users?app_id=...&limit=20`
被拒最多的用户（反滥用）。

### `GET /admin/stats/requests` — 全量列表（分页、过滤）

**Query**：`?app_id=&biz_type=&status=&from=&to=&limit=100`

返回数组，每条是审核记录的摘要。`limit` ≤ 500。

`status` 支持 `pass` / `reject` / `review` / `error` / `pending`。其中 `pending` 仅用于 admin 排障可见性，不进入 `/v1/moderate` 公开回调契约。

### `GET /admin/stats/requests/:id` — 单条完整详情

返回该请求的所有字段，含 `content_hash` / `prompt_version` / `tokens` / `extra` / `mode` / `error_code` 等。仅 admin 可见，不需要应用 HMAC。

### `GET /admin/stats/callbacks?failed=1&limit=50` — 回调投递记录

每次 webhook 投递的尝试结果（HTTP 状态、重试次数、最后错误、下次重试时间）。`failed=1` 只看未投递成功的。

---

## Analyze Records（内容服务记录）

### `GET /admin/analyze-records`

**Query**：`?app_id=&biz_type=&biz_id=&status=&delivery_mode=&from=&to=&limit=100&cursor=...`

返回 analyze 长留存记录摘要。`limit` ≤ 500。

每条包含：

- `request_id`
- `app_id`
- `biz_type`
- `biz_id`
- `user_id`
- `mode`
- `status`
- `provider`
- `model`
- `cached`
- `tokens`
- `latency_ms`
- `error_code`
- `delivery_mode`
- `delivered_at`
- `acked_at`
- `created_at`
- `completed_at`

### `GET /admin/analyze-records/{request_id}`

返回单条完整详情，包含：

- `input`
- `result`
- `extra`
- `input_hash`
- `prompt_version`
- `callback_url`

用于 IRC 按 `request_id` 或 `biz_id` 对账。完整接入方 pull 契约见 [14-analyze-records.md](14-analyze-records.md)。

### `POST /admin/analyze-records/reprocess`

将历史失败 analyze 记录重新入队。旧记录保留作审计，接口会基于原 `input_json` 新建一条 `status=pending` 的 analyze request，并投递 `ANALYZE_QUEUE`。

**Request**

```json
{
  "app_id": "app_xxx",
  "biz_type": "media_analysis",
  "error_code": "schema_validation_failed",
  "from": "2026-05-25T00:00:00Z",
  "to": "2026-05-26T00:00:00Z",
  "limit": 200,
  "cursor": null,
  "dry_run": true,
  "latest_per_biz": true,
  "only_without_later_ok": true
}
```

字段说明：

- `limit` 最大 200，用 `next_cursor` 分批处理。
- `dry_run=true` 只返回候选集，不写入新记录、不入队。
- `latest_per_biz=true` 默认只选同一 `(app_id,biz_type,biz_id)` 的最新失败记录。
- `only_without_later_ok=true` 默认跳过已经有更新 `ok` 记录的业务对象。

**Response**

```json
{
  "dry_run": false,
  "selected": 1,
  "enqueued": 1,
  "skipped": 0,
  "next_cursor": null,
  "items": [
    {
      "original_request_id": "019...",
      "request_id": "019...",
      "biz_id": "irc_task_123",
      "error_code": "schema_validation_failed"
    }
  ],
  "skipped_items": []
}
```

运维建议：

- `schema_validation_failed` 等平台修复后可恢复的错误，可用本接口分批重跑。
- `unsupported_content` 若源于 IRC 帧图 URL 已过期或桶路径错误，不建议直接重跑原记录；IRC 应重新生成有效 URL 并提交新 request。
- 新记录的 `extra.reprocess` 会记录 `original_request_id` / `original_error_code` / `requested_at`，便于对账。

---

## Providers（模型与熔断状态）

### `GET /admin/providers/status`

只读接口，不请求上游模型，也不会触发 Telegram 告警。用于 Admin UI 展示当前模型配置、secret 是否存在、KV circuit breaker 状态。

```json
{
  "generated_at": "2026-05-22T00:00:00.000Z",
  "secrets": {
    "grok_configured": true,
    "gemini_configured": true
  },
  "models": {
    "grok": "grok-4-fast-non-reasoning",
    "gemini": "gemini-2.5-flash"
  },
  "circuits": [
    {
      "provider": "gemini",
      "biz_type": "media_analysis",
      "failures": 5,
      "state": "open",
      "seconds_to_close": 120,
      "open_until": "2026-05-22T00:02:00.000Z",
      "last_failure_at": "2026-05-22T00:00:00.000Z"
    }
  ]
}
```

需要真实请求上游并可能触发告警时，使用 `POST /admin/alerts/provider-health`。

---

## Audit（管理动作审计）

### `GET /admin/audit`

**Query**：`?actor=&action=&target_type=&target_id=&from=&to=&limit=100&cursor=...`

返回管理后台高影响动作审计日志。当前记录：

- `app.create`
- `app.update`
- `app.rotate_secret`
- `prompt.publish`
- `prompt.rollback`

审计日志不会记录 app secret 明文。

**Response**

```json
{
  "items": [
    {
      "id": 123,
      "actor": "admin",
      "action": "app.rotate_secret",
      "target_type": "app",
      "target_id": "app_xxx",
      "metadata": {
        "name": "IRC"
      },
      "created_at": "2026-05-22T00:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

`actor` 优先取 Cloudflare Access 的 `cf-access-authenticated-user-email`，其次取 `x-admin-actor`，否则为 `admin`。

---

## Requests（历史查询）

### `GET /admin/requests`

**Query**：`?app_id=...&biz_type=...&status=reject&from=...&to=...&cursor=...&limit=100`

### `GET /admin/requests/{request_id}`
返回完整请求 + 模型原始输出（脱敏可选）。

### `POST /admin/requests/{request_id}/replay`
用当前 active prompt 重新审核一遍。用于评估 prompt 效果。

---

## Alerts（告警）

### `POST /admin/alerts/test`
手动发一条测试 Telegram 消息，用于验证 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` 配置正确。

返回：
```json
{ "sent": true, "bot_configured": true, "chat_configured": true }
```

### `POST /admin/alerts/check`
立即执行一次阈值检查（等价于 Cron 的 `*/5 * * * *` 那一拍），返回当前样本 + 是否触发告警。

返回：
```json
{
  "checks": ["total=120 errors=3 err_rate=2.50% max_lat=4500ms"],
  "fired": []
}
```

阈值在 `src/alerts/telegram.ts` 的 `DEFAULT_THRESHOLDS` 中定义，改完重新部署生效。

### `POST /admin/alerts/provider-health`

立即执行一次 provider health 检查。生产 Cron 每小时自动跑一次；这个接口用于手动确认 Grok / Gemini / xAI 是否正常、是否触发告警。

---

## 错误响应格式

同 Public API：
```json
{ "error_code": "not_found", "message": "app not found" }
```

常见错误码：`unauthorized` / `forbidden` / `not_found` / `validation_error` / `conflict`.
