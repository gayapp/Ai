# 13 · Analyze 回调契约 ★

> 本文档仅适用于 `/v1/analyze` 内容服务。`/v1/moderate` 仍以 [04-callback-spec.md](04-callback-spec.md) 为唯一契约，不因本文档新增字段。
>
> analyze callback 使用 `schema_version="1.1"`。兼容承诺：不删除字段、不改变字段含义；新增字段只追加，消费方必须忽略未知字段。

## 1. 回调方式

```
POST {callback_url}
Content-Type: application/json
X-Signature: hex(HMAC-SHA256(app_secret, raw_body))
X-Timestamp: <unix seconds>
X-Request-Id: <request_id>
```

签名算法与 moderate 系一致，见 [04-callback-spec.md](04-callback-spec.md#签名校验应用端)。

## 2. JSON 结构

成功回调：

```json
{
  "schema_version": "1.1",
  "request_id": "01HXYZ...",
  "app_id": "app_irc",
  "biz_type": "media_analysis",
  "biz_id": "video-12345",
  "user_id": "u_88991",
  "status": "ok",
  "result": {
    "moderation": {
      "decision": "approve",
      "confidence": 0.98,
      "summary": "No policy violation found.",
      "violations": []
    },
    "tags": {
      "tag_names": ["studio", "indoor"],
      "extra_tag_names": [],
      "categories": {
        "meta": {},
        "appearance": {},
        "context": {},
        "production": {}
      },
      "summary": "Indoor studio scene.",
      "status": "ready"
    },
    "ad_detection": {
      "is_ad": false,
      "categories": [],
      "elements": [],
      "contacts": [],
      "urls": [],
      "reason": "No ad signals."
    },
    "face_coordinates": [],
    "region": {
      "code": "japan",
      "requested_code": "japan",
      "confidence": 0.72,
      "reasoning": "Visual and text signals are consistent.",
      "signals": {}
    }
  },
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "prompt_version": 1,
  "cached": false,
  "tokens": { "input": 4823, "output": 1102 },
  "latency_ms": 8431,
  "delivery_mode": "both",
  "extra": { "trace_id": "irc-001" },
  "created_at": "2026-05-19T08:00:01Z"
}
```

失败回调：

```json
{
  "schema_version": "1.1",
  "request_id": "01HXYZ...",
  "app_id": "app_irc",
  "biz_type": "media_intro",
  "biz_id": "video-12345",
  "user_id": null,
  "status": "error",
  "error_code": "not_implemented",
  "message": "Analyze biz_type is not implemented yet.",
  "provider": null,
  "model": null,
  "prompt_version": null,
  "cached": false,
  "tokens": { "input": 0, "output": 0 },
  "latency_ms": 0,
  "delivery_mode": "both",
  "extra": {},
  "created_at": "2026-05-19T08:00:01Z"
}
```

## 3. 字段定义

| 字段 | 类型 | 允许值 / 约束 | 说明 |
|------|------|---------------|------|
| `schema_version` | string | 固定 `"1.1"` | analyze 系 callback 版本 |
| `request_id` | string | UUIDv7 | 本次 analyze 请求唯一 ID |
| `app_id` | string | `app_*` | 应用 ID |
| `biz_type` | enum | `media_analysis \| media_intro` | 内容服务业务类型 |
| `biz_id` | string | ≤128 | 应用侧业务 ID |
| `user_id` | string \| null | ≤128 | 应用提交的 user_id，可空 |
| `status` | enum | `ok \| error` | analyze 最终状态 |
| `result` | object | 按 biz_type 决定 | `status="ok"` 时返回；`status="error"` 时省略 |
| `error_code` | string | 见下 | `status="error"` 时返回 |
| `message` | string | | 人类可读错误信息 |
| `provider` | enum \| null | `grok \| gemini \| xai` | 实际调用的上游；未调用时为 null |
| `model` | string \| null | | 模型标识 |
| `prompt_version` | integer \| null | | 使用的 prompt 版本 |
| `cached` | boolean | | 是否命中去重缓存 |
| `tokens.input` | integer | | 输入 token 数 |
| `tokens.output` | integer | | 输出 token 数 |
| `latency_ms` | integer | | 端到端耗时 |
| `delivery_mode` | enum | `callback \| pull \| both` | 请求实际交付模式 |
| `extra` | object | ≤4KB | 应用提交时的 `extra` 原样回传 |
| `created_at` | string | ISO-8601 | analyze 完成时间 |

analyze 系不返回 moderate 专属的 `risk_level` / `categories` / `reason`。业务结果统一放在 `result` 下。

## 4. `status` 语义

| status | 含义 | 消费方建议动作 |
|--------|------|----------------|
| `ok` | 内容服务成功完成，`result` 可用 | 按 biz_type result schema 解析并入库 |
| `error` | 内容服务失败 | 按 `error_code` 决定重试、降级或转人工处理 |

`status="error"` 的请求也会按 `delivery_mode` 交付；pull 消费方处理完错误结果后同样需要 ack。

## 5. 常见 error_code

| error_code | 含义 | 建议 |
|------------|------|------|
| `not_implemented` | 该 biz_type 入口已接入但真实 provider 尚未实现 | 等平台发布对应任务后重试 |
| `invalid_request` | 请求体或 biz_type input schema 不合法 | 修正请求后重新提交 |
| `biz_type_not_allowed` | app 未启用该 analyze biz_type | 联系平台管理员开通 |
| `unsupported_content` | 输入内容无法处理，例如 URL 不可访问或文件类型不支持 | 修正素材或跳过 |
| `provider_error` | 上游模型异常 | 退避重试 |
| `provider_auth_failed` | 平台侧 provider key 失效 | 退避，等待平台告警处置 |
| `service_unavailable` | 主备 provider 均不可用 | 退避重试或走业务兜底 |
| `schema_validation_failed` | 模型返回不符合 Zod schema | 可重试；持续出现需平台调整 prompt |
| `sync_timeout` | 同步等待超时，任务已转异步 | 等 callback 或 pull |

## 6. Result schema

### 6.1 `media_analysis`

`media_analysis` 同时覆盖单图与多帧视频分析。字段规则：

- 始终返回：`moderation` / `tags` / `ad_detection` / `region` / `face_coordinates`
- 单图 `image_urls.length === 1`：返回 `description` / `score` / `scoring_breakdown`
- 多帧 `image_urls.length > 1`：返回 `cover_candidates` / `trial` / `frame_notes`
- 不适用字段省略

完整字段见 [12-content-service.md](12-content-service.md#5-media_analysis-schema)。

### 6.2 `media_intro`

```ts
{
  intro: string;
  title_suggestions?: string[];
  beats?: { timestamp_seconds: number; summary: string }[];
}
```

完整输入输出说明见 [12-content-service.md](12-content-service.md#6-media_intro-schema)。

## 7. 重试、幂等与 ack

- callback 投递失败按现有策略重试：`1min → 5min → 30min → 2h → 12h`，5 次后进 DLQ
- 消费方必须按 `request_id` 幂等处理
- `delivery_mode="both"` 时，消费方处理完 callback 后仍应调用 `POST /v1/analyze/{request_id}/ack`
- `delivery_mode="pull"` 与 `both` 的 cursor 拉取、ack 规则见 [14-analyze-records.md](14-analyze-records.md)

## 8. 兼容性承诺

- [04-callback-spec.md](04-callback-spec.md) 不因 analyze 系新增字段而变化
- moderate 系 callback 不出现 `result` / `delivery_mode`
- analyze 系字段新增必须向后兼容
- result schema 至少保持 6 个月向后兼容；优先通过 prompt 调整修复模型输出，不轻易改契约
