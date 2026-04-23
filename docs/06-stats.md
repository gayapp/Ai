# 06 · 统计维度与口径

本项目**不做计费**，统计仅用于观测、审计、反滥用。所有数据写入 D1 `moderation_requests`，Cron 按小时/日汇总到 `stats_rollup`，Admin UI 查询走汇总表。

## 写入路径

- 每次审核完成（无论 pass/reject/review/error/cached）都写一条 `moderation_requests`。
- 字段涵盖：`app_id`、`biz_type`、`provider`、`model`、`status`、`risk_level`、`categories`、`input_tokens`、`output_tokens`、`latency_ms`、`cached`、`prompt_version`。
- 热路径写 D1 若成为瓶颈，可改为写入 KV 计数器，Cron 批量 flush（Phase 3+ 评估）。

## 汇总任务

| Cron | 频率 | 任务 |
|------|------|------|
| `0 * * * *` | 整点 | 聚合上一小时到 `stats_rollup(period='hour')` |
| `5 0 * * *` | 每日 00:05 UTC | 聚合昨天到 `stats_rollup(period='day')`，同时清理 90 天前的 `moderation_requests` 明细（保留 rollup） |

聚合维度：`(period, period_start, app_id, biz_type, provider)`。

## 可查询的指标

### 1. 请求量
- 总请求数 `count_total`
- 缓存命中数 `count_cached`
- 缓存命中率 = `count_cached / count_total`

### 2. 判定分布
- 通过 `count_pass`
- 拒绝 `count_reject`
- 复审 `count_review`
- 错误 `count_error`
- 通过率 = `count_pass / (count_total - count_error)`

### 3. Token 消耗
- 输入 token 总和 `input_tokens`
- 输出 token 总和 `output_tokens`
- 注意：**缓存命中的请求也计 token = 0**，不影响实际消耗统计。

### 4. 延迟
- `latency_p50_ms` / `latency_p95_ms`
- 包含 Worker 处理 + 上游 API 时间；**不包含** 异步模式下 Queue 等待到回调送达的墙钟时间。

### 5. 反滥用（扫 `moderation_requests` 实时出）
- 按 `app_id × user_id` Top N：被拒次数最多的用户。
- 按 `app_id × biz_type × category`：各 app 最高发的违规类别。

---

## Admin UI 首页 3 张图

| 图 | 维度 | 数据源 |
|----|------|--------|
| QPS 趋势（24h） | 时间序列，堆叠 by biz_type | `stats_rollup(period='hour')` |
| Token 消耗（7d） | 时间序列，堆叠 by provider | `stats_rollup(period='day')` |
| 通过率 + 缓存命中率（7d） | 双折线 | `stats_rollup(period='day')` |

## 下钻页

- **Apps 列表**：每行展示 24h 请求数、通过率、错误率。
- **App 详情**：切换 biz_type / provider，看单 app 的时序图。
- **高风险类别排行**：按 `categories` 展开计数。
- **异常监控**：错误率 > 5%、P95 > 15s、DLQ 非空时告警。

## 口径约定

- **"请求数"** = 进到 `/v1/moderate` 并通过 HMAC 校验的请求数（包括 error 的）。被 401/400 挡在门外的**不计**。
- **"缓存命中"** = `cached=1` 的记录。走 KV 命中即算，不区分 hit 后有没有再处理。
- **"错误"** 的定义：模型调用失败 / 返回结构不合 Zod / 超时 / provider 熔断且无备。应用侧自己的回调接收失败**不计**在审核错误里（单独看 `callback_deliveries`）。

## 数据保留

| 表 | 保留策略 |
|----|---------|
| `moderation_requests` | 90 天明细（含 reason / categories）；超过删除 |
| `stats_rollup` (hour) | 60 天 |
| `stats_rollup` (day) | 永久 |
| `callback_deliveries` | 30 天 |

清理任务合并在日级 Cron 中执行。
