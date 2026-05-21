# 00 · 项目速览

## 背景

公司有多个 C 端应用需要做 UGC 审核（评论、昵称、简介、头像）。过去各应用各自对接 AI，重复建设，prompt 分散，配额散落，无法聚合统计，相同内容反复烧 token。

本项目是**统一的 AI 中间平台**：当前包含两条并行轨道。moderate 线服务 UGC 审核，对下对接 Grok（文本）/ Gemini（视觉 + 兜底），对上以固定 JSON 契约服务所有内部应用；analyze 线服务内容分析 / 生成，复用同一套鉴权、限流、provider、prompt、Queue 和统计基础设施。

## 核心价值

- **单点对接**：应用只认一个 API，不关心上游是 Grok 还是 Gemini。
- **去重省钱**：相同内容自动复用结果（KV 缓存，按 prompt 版本失效）。
- **可调可观测**：运营在 Admin UI 热更新 prompt；运维可按 app / 业务 / 模型 / 时间 聚合看请求数、通过率、token、延迟。
- **高可用低延迟**：跑在 Cloudflare 边缘，跨区免运维。

## 非目标

- 不做计费（仅统计）。
- 不做审核结果的业务侧处置（打回/封禁由各应用自决）。
- moderate 线不长期留存用户原始数据（审核记录按策略 TTL 清理）。
- analyze 线不处理终端用户原始 UGC，`input_json` / `result_json` 长保留用于复跑、对账和调试。

## 双轨：moderate + analyze

| 轨道 | 端点 | 业务边界 | 契约文档 |
|------|------|----------|----------|
| moderate | `/v1/moderate` | UGC 审核：评论、昵称、简介、头像 | [02-api-public.md](02-api-public.md) + [04-callback-spec.md](04-callback-spec.md) |
| analyze | `/v1/analyze` | 内容服务：图片 / 视频帧分析、视频简介生成 | [12-content-service.md](12-content-service.md) + [13-callback-spec-analyze.md](13-callback-spec-analyze.md) + [14-analyze-records.md](14-analyze-records.md) |

两条线共享平台能力，但端点、biz_type 命名空间、D1 表、Queue 任务和 callback result schema 独立演进。`/v1/moderate` 现有 4 个 biz_type 的请求 / 回调字段不因 analyze 线改变。

## 支持的业务类型

| track | biz_type | 说明 | 默认 provider | 输入 |
|-------|----------|------|--------------|------|
| moderate | `comment` | 用户评论审核 | Grok | 文本 |
| moderate | `nickname` | 用户昵称审核 | Grok | 短文本 |
| moderate | `bio` | 用户简介审核 | Grok | 中等长度文本 |
| moderate | `avatar` | 用户头像审核 | Gemini Vision | 图片 URL |
| analyze | `media_analysis` | 图片 / 视频帧多模态分析 | Gemini | 1..16 张图片 URL + 上下文 |
| analyze | `media_intro` | 视频简介生成 | xAI | 标题、标签、帧摘要、OCR、字幕等 |

新增业务类型见 [../.claude/skills/add-biz-type/SKILL.md](../.claude/skills/add-biz-type/SKILL.md)。

## 响应模式（混合自适应）

- **auto（默认）**：短文本同步返回，超过 10s 自动降级为异步回调。
- **sync**：同步等待到完成或超时（超时返回 `request_id`，结果转回调）。
- **async**：立即返回 `202 + request_id`，结果通过回调送达。
- **缓存命中**：无论任何模式都秒返。

analyze 线额外支持 `delivery_mode ∈ {callback, pull, both}`，默认 `both`。详见 [02-api-public.md](02-api-public.md#响应模式) 与 [14-analyze-records.md](14-analyze-records.md)。

## 关键决策速记

| 决策点 | 结论 |
|--------|------|
| 头像传参 | URL（不走 base64，不先上传） |
| 应用认证 | HMAC-SHA256 + 时间戳 + Nonce 防重放 |
| 响应模式 | 混合自适应 |
| 路由策略 | 业务类型配主 provider，失败熔断切备 |
| Prompt 管理 | D1 存储 + KV 缓存 60s，版本化，发布即生效 |
| 回调契约 | 代码层 Zod 锁死；prompt 改不了结构 |
| 内容服务交付 | analyze 线支持 callback + pull 双轨，默认 `both` |

## 实施顺序

| Phase | 内容 | 工时 |
|-------|------|------|
| 0 | 工程脚手架：pnpm / TS / wrangler.toml / CI | 0.5 天 |
| 1 | HMAC + `/v1/moderate` 同步 + Grok + comment + dedup + D1 | 1.5 天 |
| 2 | Gemini Vision + avatar + nickname + bio + Queue + 异步回调 + 自适应降级 | 2 天 |
| 3 | Admin API + Admin UI（Apps/Prompts/Stats）+ Stats rollup cron | 2 天 |
| 4 | OpenAPI 文档、Runbook、密钥轮换、灰度部署 | 1 天 |

**MVP 总计：7 工作日。**

## 线上入口

| 类型 | URL |
|------|-----|
| **Prod API** | https://aicenter-api.1.gay |
| **Admin UI** | https://aicenter.1.gay |
| 架构图 | https://aicenter-api.1.gay/architecture |
| Dev API | https://ai-guard-dev.schetkovvlad.workers.dev |

## 监控告警

错误率 ≥5% 或 延迟 ≥15s → **Telegram 自动推送**（每 5 分钟检查）。详见 [11-alerts.md](11-alerts.md)。

## 下一步阅读

- 架构细节 → [01-architecture.md](01-architecture.md)
- 我要接入 → [02-api-public.md](02-api-public.md)
- 我要管理（Admin API） → [03-api-admin.md](03-api-admin.md)
- 内容服务 → [12-content-service.md](12-content-service.md)
- Analyze 回调 → [13-callback-spec-analyze.md](13-callback-spec-analyze.md)
- Analyze 调用记录 / pull → [14-analyze-records.md](14-analyze-records.md)
- Analyze 灰度 → [15-analyze-gray-runbook.md](15-analyze-gray-runbook.md)
- IRC Analyze 接入交接 → [apps/IRC-analyze-handoff.md](apps/IRC-analyze-handoff.md)
- Admin Web UI → [10-admin-ui.md](10-admin-ui.md)
- 告警 → [11-alerts.md](11-alerts.md)
- 已接入的应用 → [apps/](apps/)
