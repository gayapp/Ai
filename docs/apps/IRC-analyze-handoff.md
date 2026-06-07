# IRC Analyze 接入交接

> 更新日期：2026-05-22  
> 范围：IRC 端接入 ai-guard `/v1/analyze` 的生产交接说明。本文不包含任何 secret。

## 生产状态

ai-guard 生产环境已可用于 IRC 侧灰度：

| 项 | 状态 |
| --- | --- |
| Worker | 已部署，`https://aicenter-api.1.gay` |
| Admin UI | 已部署，`https://aicenter.1.gay` / `https://ai-guard-admin.pages.dev` |
| D1 migrations | `0006` 到 `0011` 已应用 |
| Queue | `ai-guard-analyze` / `ai-guard-analyze-dlq` 已创建 |
| Analyze app config | 已启用 `media_analysis` / `media_intro` |
| Delivery mode | `both` |
| Pull ack backlog | 最近 smoke 后为 0 |
| Provider | IRC app 使用 `provider_strategy=grok`，analyze 线只走 xAI / Grok，不 fallback 到 Gemini |

当前生产已启用 analyze 的 app：

```text
app_id: app_50b5c734c751d589
name: IRC
analyze_biz_types: ["media_analysis", "media_intro"]
delivery_mode: both
provider_strategy: grok
```

如果 IRC 需要与“一起看”正式应用隔离，应在 Admin UI `/apps` 新建独立 app：点击 `New app` 后使用 `IRC analyze` 预设，再把 `AI_GUARD_APP_ID` / secret 切到新 app。

## apps 表 `biz_types` 字段语义（注意：不包括 analyze）

IRC analyze app（如 `app_50b5c734c751d589`）的 `biz_types` 字段为 `[]`，**这是正确的配置，不是漏配**。

- `apps.biz_types` 只控制 **moderation 接口** 的 biz 准入（见 [moderate.ts:44](../../src/routes/moderate.ts#L44)）。IRC 不调 moderation 接口，所以 `biz_types=[]`。
- **analyze 接口不读这个字段** — analyze 准入通过 `prompts` 表 + `provider_strategy` 路由决定：只要 D1 里有该 `biz_type` 的 active prompt，且 app 的 `provider_strategy` 路由能解到可用 provider，请求就被接受。
- IRC 使用 `media_analysis` 和 `media_intro` 这两个 analyze biz_type，是通过 `prompts` 表中存在对应 active 行启用的。

未来若 Admin UI 想展示"该 app 开启了哪些 biz"，应分两块：moderation biz 来自 `apps.biz_types`，analyze biz 来自 `prompts` 表的 active 行 join。

## IRC 侧建议配置

```env
AI_BACKEND=ai_guard
AI_GUARD_BASE_URL=https://aicenter-api.1.gay
AI_GUARD_APP_ID=app_50b5c734c751d589
AI_GUARD_APP_SECRET=<从安全渠道读取>
AI_GUARD_DELIVERY_MODE=both
AI_GUARD_TIMEOUT_SECONDS=180
AI_GUARD_POLL_INTERVAL_SECONDS=5
```

回滚只需要：

```env
AI_BACKEND=internal
```

## 接口映射

| IRC 调用 | ai-guard analyze |
| --- | --- |
| 视频帧分析 | `POST /v1/analyze`，`biz_type="media_analysis"`，`input.image_urls` 传 1..16 张 HTTPS 图片 |
| 图片 AI 分析部分 | `POST /v1/analyze`，`biz_type="media_analysis"`，单图传 `image_urls.length=1` |
| 简介生成 | `POST /v1/analyze`，`biz_type="media_intro"` |

不迁移：

- OCR / 人脸 / 地区本地模型：仍在 IRC 端执行。
- 小说分析：本期不进 ai-guard。
- IRC 对上游业务方的 callback 协议：短期不改，IRC 仍作为中转层。

## 交付模式

线上实时场景建议使用 `both`：

1. IRC 提交 analyze 请求。
2. ai-guard 完成后 callback 到 IRC。
3. IRC 收到 callback 后处理业务状态。
4. IRC 仍调用 `POST /v1/analyze/{request_id}/ack`。
5. IRC cron 每分钟 pull 兜底未 ack 结果。

批量回填可单条请求传：

```json
{
  "delivery_mode": "pull"
}
```

这样不会反向打 callback，只由 IRC 控速 pull。

## Pull 三接口

```http
GET /v1/analyze/{request_id}
GET /v1/analyze?status=ok&include=unacked&limit=50
POST /v1/analyze/{request_id}/ack
```

所有接口都使用 ai-guard HMAC：

```text
x-app-id: <AI_GUARD_APP_ID>
x-timestamp: <unix seconds>
x-nonce: <random hex>
x-signature: HMAC_SHA256(secret, timestamp + "\n" + nonce + "\n" + sha256(body))
```

GET 请求签空 body。ack 建议也签空 body。

## 灰度建议

从 IRC feature flag 推进：

| 阶段 | 比例 | 最短观察 |
| --- | ---: | ---: |
| 1 | 10% | 24h |
| 2 | 25% | 24h |
| 3 | 50% | 24h |
| 4 | 100% | 24h |

升档前查：

```bash
BASE=https://aicenter-api.1.gay \
ADMIN_TOKEN=<prod-admin-token> \
APP_ID=app_50b5c734c751d589 \
BASELINE_P95_MS=<IRC internal p95> \
WINDOW_HOURS=24 \
node scripts/analyze-gray-report.mjs --assert
```

也可以在管理后台直接查看：<https://aicenter.1.gay/#/analyze-ops>。选择 IRC app、填入 IRC 原方案 `baseline p95 ms`，`Ready=YES` 且所有 gate 通过后再升档。

注意：2026-05-21 的 24h 窗口包含多条生产 smoke 失败样本。正式灰度请以实际开始时间作为 `from`，不要用被 smoke 污染的 24h 默认窗口做升档判断。

## 已验证 Smoke

生产 smoke 已通过：

- `media_intro`：`status=ok`，pull 成功，ack 成功。
- `media_analysis`：`status=ok`，pull 成功，ack 成功。
- fresh window：`ok=2 / error=0 / pull_unacked=0`。

`media_analysis` 当前通过 xAI / Grok 跑通。IRC app 设置为 `provider_strategy=grok` 后，ai-guard 不会把 IRC analyze 请求转交 Gemini；xAI 临时不可用时请求保持 `pending`，由队列重试和 pending sweep 追赶。

## 失败重提指令（转发给 IRC agent）

请只处理 IRC 侧仍没有后续成功结果的任务；不要覆盖 ai-guard 旧 `request_id`，旧记录保留审计。重新提交后以新的 ai-guard `request_id` 覆盖 IRC 业务状态。

### `unsupported_content`

含义：ai-guard 无法读取素材，常见原因是帧图 URL 过期、bucket 路径错误、非 `https://`、返回非图片 content-type、403/404/5xx。

处理步骤：

1. 找到 IRC 任务对应的原始素材 / 视频帧。
2. 重新生成 1..16 张帧图，上传到稳定可公网读取的 HTTPS URL。
3. 在 IRC 侧提交前逐个校验 URL：`GET` 返回 `200`，`content-type` 是 `image/jpeg` / `image/png` / `image/webp`，且 URL 至少在 ai-guard 处理窗口内有效。
4. 重新调用 `POST /v1/analyze`，使用原 `biz_id`，`biz_type="media_analysis"`，`input.image_urls` 传新的 URL 列表。
5. 记录新的 `request_id`，等待 callback 或 pull 结果；收到最终结果后调用 ack。

### `invalid_request`

含义：请求 JSON 没通过 ai-guard input schema。

`media_analysis` 必须满足：

```json
{
  "biz_type": "media_analysis",
  "biz_id": "<stable IRC task id>",
  "input": {
    "image_urls": ["https://..."],
    "title": "optional, <=2048 chars",
    "duration_seconds": 123,
    "frame_metadata": [
      { "timestamp_seconds": 1.2, "quality_score": 0.9, "scene_id": 1 }
    ],
    "region_hint": "optional"
  },
  "delivery_mode": "both"
}
```

校验要点：`image_urls` 必须是 1..16 个 `https://` URL；`duration_seconds` 是非负整数；`timestamp_seconds` / `quality_score` 是非负数字；`title` 最长 2048 字符。

`media_intro` 必须满足：

```json
{
  "biz_type": "media_intro",
  "biz_id": "<stable IRC task id>",
  "input": {
    "title": "required, 1..2048 chars",
    "duration_seconds": 123,
    "tags": ["optional"],
    "frame_notes": [
      { "timestamp_seconds": 1.2, "summary": "frame summary" }
    ],
    "ocr_lines": ["optional"],
    "subtitle_text": "optional",
    "trial_excerpt": "optional",
    "style_hint": "concise",
    "max_length": 300
  },
  "delivery_mode": "both"
}
```

校验要点：`title` 必填；`style_hint` 只能是 `concise` / `narrative` / `marketing`；`max_length` 范围 50..2000。

## IRC 实现注意点

- `media_analysis` 是视频/图片合并 biz_type；`image_urls.length=1` 和 `>1` 的结果字段不同，详见 [../12-content-service.md](../12-content-service.md)。
- ai-guard 会长保留完整 `input_json` / `result_json`，IRC 侧可以按 `biz_id` 对账。
- 收到 `status=error` 也要 ack，避免重复 pull。
- `delivery_mode=callback` 的请求不能 ack；IRC 建议使用 `both` 或 `pull`。
- 完整 `waiting_ai` 状态机属于 IRC 侧实现。上线前至少要保证：提交后记录 `request_id`、可恢复 pull、处理后 ack、失败可重试或回滚 internal。
