# 02 · Public API（业务应用使用）

本文档给业务应用开发者。所有接口以 HTTPS 提供，经由 Cloudflare Worker 路由 `https://ai-guard.<domain>/v1/*`。

## 鉴权

所有请求必须携带以下 Header：

| Header | 说明 |
|--------|------|
| `X-App-Id` | 应用 ID，由管理端签发（例：`app_7f3a2c8d`） |
| `X-Timestamp` | Unix 秒级时间戳；服务端允许 ±300s 偏移 |
| `X-Nonce` | 16 字节随机 hex；5 分钟内不可重复（服务端用 KV 去重） |
| `X-Signature` | HMAC-SHA256 签名，见下 |
| `Content-Type` | `application/json` |

**签名算法**

```
string_to_sign = X-Timestamp + "\n" + X-Nonce + "\n" + hex(sha256(body))
X-Signature    = hex(HMAC-SHA256(app_secret, string_to_sign))
```

Node.js 示例：
```js
import crypto from "node:crypto";

function sign(secret, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const stringToSign = `${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(stringToSign).digest("hex");
  return { timestamp, nonce, signature };
}
```

---

## `POST /v1/moderate` — 提交审核

### Request Body

```json
{
  "biz_type": "comment",
  "biz_id": "app-side-post-12345",
  "content": "要审核的文本 或 图片 URL",
  "user_id": "u_88991",
  "mode": "auto",
  "callback_url": "https://myapp.com/hooks/moderate",
  "extra": { "anything": "会原样回传" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `biz_type` | string | ✓ | `comment` / `nickname` / `bio` / `avatar` |
| `biz_id` | string | ✓ | 应用侧业务 ID，回调原样带回。长度 ≤ 128 |
| `content` | string | ✓ | 文本内容（≤ 8KB）或图片 URL（`https://` 起） |
| `user_id` | string |  | 终端用户 ID，用于滥用统计 |
| `mode` | enum |  | `sync` / `async` / `auto`（默认） |
| `callback_url` | string |  | 覆盖应用默认回调地址。仅 async 或降级时使用 |
| `extra` | object |  | ≤ 4KB，回调原样回传 |

### 响应模式

| mode | 条件 | 响应 |
|------|------|------|
| `auto` | 10s 内完成 | `200` + 结果 |
| `auto` | 超 10s 或是 `avatar` | `202 + request_id`，后续回调 |
| `sync` | 始终等待 | `200` + 结果（超限返回 504 提示改用 async） |
| `async` | 立即返回 | `202 + request_id`，后续回调 |
| 任意模式 + 命中缓存 | 总是 | `200` + 结果 + `cached=true` |

### Response 200（同步 / 缓存命中）

```json
{
  "request_id": "01HXYZ...",
  "cached": true,
  "result": {
    "status": "pass",
    "risk_level": "safe",
    "categories": [],
    "reason": "内容正常"
  }
}
```

### Response 202（异步）

```json
{ "request_id": "01HXYZ...", "accepted_at": "2026-04-23T08:00:00Z" }
```

之后结果通过回调送达；契约见 [04-callback-spec.md](04-callback-spec.md)。

### Response 错误

| HTTP | error_code | 含义 |
|------|-----------|------|
| 400 | `invalid_request` | 请求体不符 Zod schema |
| 401 | `bad_signature` | HMAC 校验失败 |
| 401 | `expired_timestamp` | 时间戳超出 ±300s |
| 401 | `replay_nonce` | Nonce 在 5 分钟内重复 |
| 403 | `biz_type_not_allowed` | 该 app 未启用此业务类型 |
| 404 | `app_not_found` | app_id 不存在 |
| 422 | `unsupported_content` | content 无法处理（如 URL 无法访问） |
| 429 | `rate_limited` | 超过 app 配置的 QPS |
| 500 | `provider_error` | 上游模型异常，建议重试 |
| 502 | `provider_auth_failed` | 平台一端 AI Key 失效（罕见，平台已收到告警并正在处置）；建议退避 5 分钟重试 |
| 503 | `service_unavailable` | 平台主备两家 AI 都鉴权失败（极罕见）；建议退避 10 分钟重试 |
| 504 | `sync_timeout` | sync 模式超时，请改 async |

错误响应格式：
```json
{ "error_code": "bad_signature", "message": "Signature mismatch", "request_id": "optional" }
```

---

## `GET /v1/moderate/{request_id}` — 查询结果

用于幂等复查（例如应用侧回调接收失败后重新拉取）。

**Headers**：同上，对空 body 签名即可。

**Response 200**
```json
{
  "request_id": "01HXYZ...",
  "status": "pass",
  "result": { /* ... 同回调 JSON 的字段 ... */ },
  "callback": { "delivered_at": "2026-04-23T08:00:01Z", "attempts": 1 }
}
```

**Response 404**：`request_id` 不存在或不属于该 app。

---

## `POST /v1/analyze` — 提交内容服务任务

用于提交 analyze 系内容服务任务。当前第一批 biz_type 为 `media_analysis` 与 `media_intro`。审核业务仍使用 `/v1/moderate`，不要把 analyze biz_type 提交到 moderate 端点。

### Request Body

```json
{
  "biz_type": "media_analysis",
  "biz_id": "video-12345",
  "input": {
    "image_urls": [
      "https://cdn.example.com/video-12345/frame-001.jpg"
    ],
    "title": "sample title",
    "duration_seconds": 632
  },
  "mode": "async",
  "delivery_mode": "both",
  "callback_url": "https://myapp.com/hooks/analyze",
  "user_id": "u_88991",
  "extra": { "anything": "会原样回传" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `biz_type` | string | ✓ | `media_analysis` / `media_intro` |
| `biz_id` | string | ✓ | 应用侧业务 ID，回调与 pull 结果原样带回。长度 ≤ 128 |
| `input` | object | ✓ | 按 biz_type 各自 schema 校验。详见 [12-content-service.md](12-content-service.md) |
| `mode` | enum | | `sync` / `async` / `auto`。`media_analysis` 强制异步；`media_intro` 默认 `auto` |
| `delivery_mode` | enum | | `callback` / `pull` / `both`。默认沿用 app 配置，app 默认值为 `both` |
| `callback_url` | string | | 覆盖应用默认回调地址。仅 `callback` / `both` 模式使用 |
| `user_id` | string | | 业务侧用户 ID，用于统计或排障 |
| `extra` | object | | ≤ 4KB，callback 与查询结果原样回传 |

### `media_analysis` input

```json
{
  "image_urls": ["https://cdn.example.com/frame-1.jpg"],
  "title": "sample title",
  "duration_seconds": 632,
  "frame_metadata": [
    {
      "timestamp_seconds": 12.5,
      "quality_score": 0.91,
      "scene_id": 1
    }
  ],
  "region_hint": "japan"
}
```

`image_urls` 必须是 1..16 张 `https://` 图片 URL。`image_urls.length === 1` 表示单图分析；`image_urls.length > 1` 表示视频帧分析。两者共用 `media_analysis`，result 字段差异见 [12-content-service.md](12-content-service.md#5-media_analysis-schema)。

`frame_metadata[].quality_score` 可传归一化分数 `0..1`，也可传 IRC 帧提取阶段的非负原始质量分；平台只把它作为帧质量 hint 传给模型，含义是数值越大质量越高。

### `media_intro` input

```json
{
  "title": "sample title",
  "duration_seconds": 632,
  "tags": ["studio", "indoor"],
  "frame_notes": [
    { "timestamp_seconds": 12.5, "summary": "Opening scene." }
  ],
  "ocr_lines": ["sample text"],
  "subtitle_text": "sample subtitle",
  "trial_excerpt": "sample excerpt",
  "style_hint": "concise",
  "max_length": 240
}
```

### 响应模式

| biz_type | mode | 响应 |
|----------|------|------|
| `media_analysis` | 任意 | `202 + request_id`，后续 callback 或 pull |
| `media_intro` | `auto` / `sync` 且 10s 内完成 | `200` + `result` |
| `media_intro` | `auto` 超时或 `async` | `202 + request_id`，后续 callback 或 pull |
| 任意 biz_type + 命中缓存 | 任意 | `200` + `result` + `cached=true` |

### Response 200（同步 / 缓存命中）

```json
{
  "request_id": "01HXYZ...",
  "cached": true,
  "result": {
    "intro": "这是一段视频简介。"
  }
}
```

### Response 202（异步）

```json
{ "request_id": "01HXYZ...", "accepted_at": "2026-05-19T08:00:00Z" }
```

之后结果按 `delivery_mode` 交付：

- `callback`：完成后投递 analyze callback，契约见 [13-callback-spec-analyze.md](13-callback-spec-analyze.md)
- `pull`：不投递 callback，消费方通过 [14-analyze-records.md](14-analyze-records.md) 的 pull 接口拉取并 ack
- `both`：callback 主路径，pull 作为兜底；消费方处理 callback 后仍应 ack

### Response 错误

| HTTP | error_code | 含义 |
|------|------------|------|
| 400 | `invalid_request` | 请求体不符 Zod schema |
| 401 | `bad_signature` | HMAC 校验失败 |
| 401 | `expired_timestamp` | 时间戳超出 ±300s |
| 401 | `replay_nonce` | Nonce 在 5 分钟内重复 |
| 403 | `biz_type_not_allowed` | 该 app 未启用此 analyze biz_type |
| 404 | `app_not_found` | app_id 不存在 |
| 422 | `unsupported_content` | 输入素材无法处理 |
| 429 | `rate_limited` | 超过 app 配置的 QPS |
| 500 | `provider_error` | 上游模型异常，建议重试 |
| 502 | `provider_auth_failed` | 平台一端 AI Key 失效 |
| 503 | `service_unavailable` | 主备 provider 均不可用 |
| 504 | `sync_timeout` | sync 模式超时，任务已转异步 |

---

## Analyze pull 接口

analyze 线新增三个 pull 接口：

- `GET /v1/analyze/{request_id}`：单次查询
- `GET /v1/analyze?status=ok&since_id=...`：cursor 批量拉取
- `POST /v1/analyze/{request_id}/ack`：显式确认已消费

这些接口同样使用 HMAC，GET 与 ack 均签空 body。完整参数、响应、ack 幂等规则和 IRC 推荐用法见 [14-analyze-records.md](14-analyze-records.md)。

---

## 最佳实践

### 何时用 sync vs async
- **sync**（或 auto）：用户正在等着看结果的场景（发评论前、改昵称前）。
- **async**：批量导入、后台任务、头像审核。

### 处理回调
- 必须在 10s 内返回 2xx，否则进重试队列。
- **必须** 校验回调签名（见 [04-callback-spec.md](04-callback-spec.md)）。
- 相同 `request_id` 可能收到重复回调（at-least-once），按 `request_id` 幂等处理。

### 配额与限流
- 默认 50 QPS / app，可在管理端调整（`PATCH /admin/apps/{id}`）。
- 超限返回 `429 rate_limited`，响应体含 `details.retry_after_seconds`。
- 实现是 KV 滑动窗口（每秒粒度）。CF KV 最终一致性导致**突发**可能短暂超限 2~3×，但**持续**高流量会被压制在限值附近。这是**软限流**，目的是防止单个 app 压垮平台，不是精确 QPS 管控。

### 缓存友好
- `content` 相同但 `biz_id` 不同 **不影响缓存命中**（缓存 key 只看内容 hash + biz_type + prompt_version）。
- 如果你不希望命中缓存（例如需要强制重判），加 `extra.no_cache=true`（需管理端开白）。

---

## 示例：完整 cURL

```bash
APP_ID=app_7f3a2c8d
SECRET=your_secret
BODY='{"biz_type":"comment","biz_id":"c-123","content":"你好世界"}'

TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
STRING_TO_SIGN="${TS}\n${NONCE}\n${BODY_HASH}"
SIG=$(printf '%b' "$STRING_TO_SIGN" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST https://ai-guard.example.com/v1/moderate \
  -H "X-App-Id: $APP_ID" \
  -H "X-Timestamp: $TS" \
  -H "X-Nonce: $NONCE" \
  -H "X-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```
