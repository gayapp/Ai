# IRC Analyze 接入交接

> 更新日期：2026-05-22  
> 范围：IRC 端接入 ai-guard `/v1/analyze` 的生产交接说明。本文不包含任何 secret。

## 生产状态

ai-guard 生产环境已可用于 IRC 侧灰度：

| 项 | 状态 |
| --- | --- |
| Worker | 已部署，`https://aicenter-api.1.gay` |
| Admin UI | 已部署，`https://ai-guard-admin.pages.dev` |
| D1 migrations | `0006` 到 `0011` 已应用 |
| Queue | `ai-guard-analyze` / `ai-guard-analyze-dlq` 已创建 |
| Analyze app config | 已启用 `media_analysis` / `media_intro` |
| Delivery mode | `both` |
| Pull ack backlog | 最近 smoke 后为 0 |
| Provider | xAI 可用；Gemini key 已刷新，但最近 health 仍可能返回 `429` |

当前生产已启用 analyze 的 app：

```text
app_id: app_f2ce7d84dec8ad56
name: 一起看
analyze_biz_types: ["media_analysis", "media_intro"]
delivery_mode: both
```

如果 IRC 需要与“一起看”正式应用隔离，应在 ai-guard 新建独立 `app_irc`，再把 `AI_GUARD_APP_ID` / secret 切到新 app。

## IRC 侧建议配置

```env
AI_BACKEND=ai_guard
AI_GUARD_BASE_URL=https://aicenter-api.1.gay
AI_GUARD_APP_ID=app_f2ce7d84dec8ad56
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
APP_ID=app_f2ce7d84dec8ad56 \
BASELINE_P95_MS=<IRC internal p95> \
WINDOW_HOURS=24 \
node scripts/analyze-gray-report.mjs --assert
```

注意：2026-05-21 的 24h 窗口包含多条生产 smoke 失败样本。正式灰度请以实际开始时间作为 `from`，不要用被 smoke 污染的 24h 默认窗口做升档判断。

## 已验证 Smoke

生产 smoke 已通过：

- `media_intro`：`status=ok`，pull 成功，ack 成功。
- `media_analysis`：`status=ok`，pull 成功，ack 成功。
- fresh window：`ok=2 / error=0 / pull_unacked=0`。

`media_analysis` 当前可通过 xAI fallback 跑通。Gemini health 最近仍可能出现 `http 429`，应按 provider 配额/限流问题处理，不视为 ai-guard 部署失败。

## IRC 实现注意点

- `media_analysis` 是视频/图片合并 biz_type；`image_urls.length=1` 和 `>1` 的结果字段不同，详见 [../12-content-service.md](../12-content-service.md)。
- ai-guard 会长保留完整 `input_json` / `result_json`，IRC 侧可以按 `biz_id` 对账。
- 收到 `status=error` 也要 ack，避免重复 pull。
- `delivery_mode=callback` 的请求不能 ack；IRC 建议使用 `both` 或 `pull`。
- 完整 `waiting_ai` 状态机属于 IRC 侧实现。上线前至少要保证：提交后记录 `request_id`、可恢复 pull、处理后 ack、失败可重试或回滚 internal。
