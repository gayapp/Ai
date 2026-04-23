# P1.2 · Grok Batch API 异步通道

> 目标：把不实时的审核请求（用户不等）打包投给 xAI 官方 Batch 端点，拿 **50% 折扣** + **不占实时 Rate Limit**。

## 前提

xAI 官方文档里 Batch API 要求：
- 请求整理成 JSONL 文件，每行一个 `{custom_id, method, url, body}`
- 上传后拿 `batch_id`，24h 内后台完成（通常快得多）
- 完成后下载结果 JSONL，按 custom_id 回写

## 适合进 Batch 的场景

| 场景 | 实时性要求 | 建议走 Batch？ |
|------|-----------|-------------|
| 用户发评论等审核通过 | 高（< 1s） | ❌ |
| 头像上传异步审核 | 中（< 30s） | ⚠️ 当前异步已够；若延迟到 10 分钟也 OK 则可 Batch |
| 运营人工回放历史数据 | 低 | ✅ |
| 内容入库后"冷审"（存档用户正文，定时审） | 无要求 | ✅ |
| Prompt 更新后全量回归 | 低 | ✅ 重度依赖 |

结论：**只对"应用显式说可接受延迟"的请求走 Batch**。新增 app 配置：

```sql
ALTER TABLE apps ADD COLUMN batch_mode_allowed INTEGER NOT NULL DEFAULT 0;
```

请求参数新增 `prefer_batch: true`。只有 `app.batch_mode_allowed = 1` 且 `prefer_batch = true` 才走 Batch。

## 实现（需要 P1.3 物理服务器做执行层）

### Worker 侧

1. 接到 `prefer_batch=true` 请求
2. 正常走 HMAC + dedup 检查
3. dedup miss → 创建 `moderation_requests` 行（`status=pending`, `mode=batch`）
4. 返回 `202` + `request_id`
5. 不入 MODERATION_QUEUE；而是入新的 `ai-guard-batch-staging` Queue 或 D1 标记

### Python 服务器侧

每 10 分钟 Cron：
1. 从 Admin API 拉 100 条 `status=pending AND mode=batch` 记录
2. 构造 JSONL（每行含完整的 chat/completions body）
3. 调 `POST https://api.x.ai/v1/batches`
4. 记录 `batch_id` 到新的 D1 表 `grok_batches`
5. 另一个 Cron 5 分钟轮询 Batch 状态
6. Batch 完成 → 下载结果 → 按 `custom_id` 调 Admin API 写回每条结果 + 触发回调

### D1 新表

```sql
CREATE TABLE grok_batches (
  id            TEXT PRIMARY KEY,       -- xAI 返回的 batch_id
  status        TEXT NOT NULL,          -- pending / in_progress / completed / failed
  request_count INTEGER NOT NULL,
  submitted_at  INTEGER NOT NULL,
  completed_at  INTEGER,
  error         TEXT
);

-- moderation_requests 关联
ALTER TABLE moderation_requests ADD COLUMN batch_id TEXT;
```

## 成本模型

假设：
- 平均单次文本审核 180 input + 40 output token
- Grok 实时价：$0.50/1M input + $2.00/1M output ≈ 约 $0.0001/次
- 走 Batch：50% 折扣 ≈ $0.00005/次

100 万条 / 月：
- 实时：$100
- Batch：$50
- 省 $50/月（小规模），百万级请求后扩大

**结论**：Batch 收益对小量级有限，对"日均 >= 100K 请求"才显著。**不急做**，等日均请求量到 10K+ 再上。

## 临时替代方案（不引入物理服务器）

CF Cron + D1 也能做伪 Batch，但因 Worker 没法长期持有连接等 batch 完成，需要轮询 KV，复杂度反而高。建议要做就直接做 P1.3（Python 物理服务器），Batch API 作为物理服务器的核心职责之一。

## 当前建议

- **先不做**。当前流量 Batch 省不了几十刀。
- 等 Grok 月账单 > $30 或 prod 日请求 > 5K 时再启用。
- 先通过 [edge-prefilter.md](edge-prefilter.md) 的漏斗优化压低 Token——通常能把量级压到原来 50% 以下。
