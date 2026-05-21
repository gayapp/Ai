# Analyze 灰度 Runbook

> 适用任务：T-008。本文只覆盖 analyze 系内容服务灰度，不改变 `/v1/moderate` 契约，也不要求修改 [04-callback-spec.md](04-callback-spec.md)。

## 前置条件

- T-001 至 T-007 已合并并部署到 dev。
- `app_irc` 已在 ai-guard Admin UI 启用 `media_analysis` / `media_intro`。
- `app_irc.delivery_mode` 建议为 `both`；批量回填可在单条请求上覆盖为 `pull`。
- IRC 侧具备 `AI_BACKEND=internal|ai_guard` 回滚开关。
- production 部署和 production 灰度必须等用户授权；不得私自执行 `wrangler deploy --env production`。

## Dev 冒烟

先部署 dev：

```bash
pnpm -s typecheck && pnpm -s test
wrangler d1 migrations apply ai-guard --env dev --remote
wrangler deploy --env dev
```

提交一条 `media_intro` analyze 请求，使用 pull 模式完成轮询和 ack：

```bash
BASE=https://<dev-worker> \
APP_ID=app_irc \
SECRET=<app-secret> \
DELIVERY_MODE=pull \
MODE=async \
node scripts/analyze-smoke.mjs
```

`media_analysis` 冒烟需要可由 provider 访问的 HTTPS 图片：

```bash
BASE=https://<dev-worker> \
APP_ID=app_irc \
SECRET=<app-secret> \
BIZ_TYPE=media_analysis \
IMAGE_URL=https://example.com/frame.jpg \
DELIVERY_MODE=pull \
MODE=async \
node scripts/analyze-smoke.mjs
```

脚本默认接受最终 `status=ok` 或 `status=error`，用于验证提交、Queue、pull、ack 链路。若要把 provider 成功作为硬门槛：

```bash
EXPECT_STATUS=ok node scripts/analyze-smoke.mjs
```

## 灰度节奏

灰度比例按 IRC 侧 feature flag 推进：

| 阶段 | 比例 | 最短观察 |
| --- | ---: | ---: |
| 1 | 10% | 24h |
| 2 | 25% | 24h |
| 3 | 50% | 24h |
| 4 | 100% | 24h |

任一阶段出现重大问题，停档，IRC 侧切回 `AI_BACKEND=internal`，修复后重新从 10% 开始。

## 指标与升档 Gate

ai-guard 提供管理接口：

```http
GET /admin/stats/analyze-gray?app_id=app_irc&baseline_p95_ms=<internal-p95-ms>
Authorization: Bearer <ADMIN_TOKEN>
```

接口返回：

- `status.by_status`：`pending` / `ok` / `error` 分布
- `latency_ms`：p50 / p95 / p99 / max
- `tokens.output`：p50 / p95 / p99 / max
- `error_codes`：错误码分布
- `dedup.hit_rate`：KV dedup 命中率
- `delivery.callback_undelivered` / `delivery.pull_unacked`：交付堆积
- `ready_for_next_stage`：基于下列 gate 的自动判断

升档 gate：

- `sample_size > 0`
- `error_rate < 1%`
- `pending_older_than_5m = 0`
- `dedup.hit_rate >= 30%`
- `latency_ms.p95 <= baseline_p95_ms * 1.5`

生成日报：

```bash
BASE=https://<dev-or-prod-worker> \
ADMIN_TOKEN=<admin-token> \
APP_ID=app_irc \
BASELINE_P95_MS=<irc-internal-p95-ms> \
WINDOW_HOURS=24 \
node scripts/analyze-gray-report.mjs
```

作为升档断言使用：

```bash
node scripts/analyze-gray-report.mjs --assert
```

IRC result schema diff 通过率由 IRC 侧工具产出。T-008 升档前必须人工确认 diff 通过；若发现不兼容，优先调整 prompt 或 provider normalization，只有契约确实需要演进时才开 ADR 对齐。

## 回滚

ai-guard analyze 线不影响 moderate 线，灰度回滚优先在 IRC 侧完成：

```bash
AI_BACKEND=internal
```

回滚后检查：

- IRC 三条 media AI 链路恢复 internal backend。
- ai-guard `/admin/stats/analyze-gray` 新增样本停止增长或显著下降。
- `/admin/stats/summary` 中 moderate 线错误率和延迟无回归。
- 未 ack 的 `pull` / `both` analyze 结果按业务需要继续消费或保留审计。

## T-008 验收清单

- [ ] 10% / 25% / 50% / 100% 四档均完成至少 24h 观察。
- [ ] 100% 切完后 24h analyze 错误率 < 1%。
- [ ] analyze p95 latency 不超过 IRC internal backend 的 1.5 倍。
- [ ] dedup 命中率达到预期，默认不低于 30%。
- [ ] IRC result schema diff 通过率满足灰度标准。
- [ ] moderate 线性能、错误率、请求/回调契约无回归。
