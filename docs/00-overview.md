# 00 · 项目速览

## 背景

公司有多个 C 端应用需要做 UGC 审核（评论、昵称、简介、头像）。过去各应用各自对接 AI，重复建设，prompt 分散，配额散落，无法聚合统计，相同内容反复烧 token。

本项目是**统一的审核中间平台**：对下对接 Grok（文本）/ Gemini（视觉 + 兜底），对上以固定 JSON 契约服务所有内部应用。

## 核心价值

- **单点对接**：应用只认一个 API，不关心上游是 Grok 还是 Gemini。
- **去重省钱**：相同内容自动复用结果（KV 缓存，按 prompt 版本失效）。
- **可调可观测**：运营在 Admin UI 热更新 prompt；运维可按 app / 业务 / 模型 / 时间 聚合看请求数、通过率、token、延迟。
- **高可用低延迟**：跑在 Cloudflare 边缘，跨区免运维。

## 非目标

- 不做计费（仅统计）。
- 不做审核结果的业务侧处置（打回/封禁由各应用自决）。
- 不长期留存用户原始数据（审核记录按策略 TTL 清理）。

## 支持的业务类型

| biz_type | 说明 | 默认 provider | 输入 |
|----------|------|--------------|------|
| `comment` | 用户评论 | Grok | 文本 |
| `nickname` | 用户昵称 | Grok | 短文本 |
| `bio` | 用户简介 | Grok | 中等长度文本 |
| `avatar` | 用户头像 | Gemini Vision | 图片 URL |

新增业务类型见 [../.claude/skills/add-biz-type/SKILL.md](../.claude/skills/add-biz-type/SKILL.md)。

## 响应模式（混合自适应）

- **auto（默认）**：短文本同步返回，超过 10s 自动降级为异步回调。
- **sync**：同步等待到完成或超时（超时返回 `request_id`，结果转回调）。
- **async**：立即返回 `202 + request_id`，结果通过回调送达。
- **缓存命中**：无论任何模式都秒返。

详见 [02-api-public.md](02-api-public.md#响应模式)。

## 关键决策速记

| 决策点 | 结论 |
|--------|------|
| 头像传参 | URL（不走 base64，不先上传） |
| 应用认证 | HMAC-SHA256 + 时间戳 + Nonce 防重放 |
| 响应模式 | 混合自适应 |
| 路由策略 | 业务类型配主 provider，失败熔断切备 |
| Prompt 管理 | D1 存储 + KV 缓存 60s，版本化，发布即生效 |
| 回调契约 | 代码层 Zod 锁死；prompt 改不了结构 |

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
- Admin Web UI → [10-admin-ui.md](10-admin-ui.md)
- 告警 → [11-alerts.md](11-alerts.md)
- 已接入的应用 → [apps/](apps/)
