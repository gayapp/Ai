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
  "rate_limit_qps": 100
}
```

**Response 201**
```json
{
  "id": "app_7f3a2c8d",
  "name": "my-forum",
  "secret": "only-shown-once-please-save-it",
  "callback_url": "https://myapp.com/hooks/moderate",
  "biz_types": ["comment", "nickname", "bio"],
  "rate_limit_qps": 100,
  "created_at": "2026-04-23T08:00:00Z"
}
```

> ⚠️ `secret` **仅此次明文返回**。后端只存 Argon2id hash。

### `GET /admin/apps` — 列出

**Query**：`?limit=50&cursor=...`

### `GET /admin/apps/{id}`

### `PATCH /admin/apps/{id}`
可更新：`name` / `callback_url` / `biz_types` / `rate_limit_qps` / `disabled`。

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

### `GET /admin/stats/timeseries`

**Query**：`?period=hour&metric=count&group_by=biz_type&from=...&to=...`

返回时间序列数据，供前端画图。

### `GET /admin/stats/top-users?app_id=...&limit=20`
被拒最多的用户（反滥用）。

### `GET /admin/stats/categories?biz_type=comment&from=...&to=...`
高风险类别分布。

---

## Requests（历史查询）

### `GET /admin/requests`

**Query**：`?app_id=...&biz_type=...&status=reject&from=...&to=...&cursor=...&limit=100`

### `GET /admin/requests/{request_id}`
返回完整请求 + 模型原始输出（脱敏可选）。

### `POST /admin/requests/{request_id}/replay`
用当前 active prompt 重新审核一遍。用于评估 prompt 效果。

---

## Callbacks（投递观测）

### `GET /admin/callbacks?status=failed&limit=50`
失败/重试中的回调列表。

### `POST /admin/callbacks/{request_id}/retry`
手工触发重试。

---

## 错误响应格式

同 Public API：
```json
{ "error_code": "not_found", "message": "app not found" }
```

常见错误码：`unauthorized` / `forbidden` / `not_found` / `validation_error` / `conflict`.
