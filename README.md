# ai-guard

基于 Cloudflare Workers 的统一 AI 审核中间平台。对接 Grok（文本）与 Gemini（视觉），为公司内所有 C 端应用提供**评论 / 昵称 / 简介 / 头像** 四类 UGC 审核服务。

**核心特性**
- 统一 API + 固定 JSON 回调契约，应用零感知上游是哪家模型。
- 相同内容自动去重复用结果，省 token。
- Prompt 可在 Admin UI 热更新；输出结构由代码层 Zod 锁死。
- 混合自适应响应：短文本同步返回，慢请求与图片走异步回调。
- 统计（不计费）：按 app / 业务 / provider / 时间 聚合请求数、通过率、token、延迟。

## 快速链接

| 你想 | 看这里 |
|------|--------|
| 了解项目全貌 | [docs/00-overview.md](docs/00-overview.md) |
| 理解架构与数据模型 | [docs/01-architecture.md](docs/01-architecture.md) |
| 接入这个平台（业务应用开发者） | [docs/02-api-public.md](docs/02-api-public.md) |
| 管理应用 / 改 prompt / 看统计 | [docs/03-api-admin.md](docs/03-api-admin.md) |
| 回调 JSON 字段定义 | [docs/04-callback-spec.md](docs/04-callback-spec.md) |
| 调 prompt 的正确姿势 | [docs/05-prompts.md](docs/05-prompts.md) |
| 看哪些统计指标 | [docs/06-stats.md](docs/06-stats.md) |
| 线上出问题怎么办 | [docs/07-runbook.md](docs/07-runbook.md) |

## 本地开发

```bash
pnpm install
pnpm -s typecheck
pnpm dev            # wrangler dev，本地起 D1/KV/Queue 模拟器
pnpm test
```

## 目录速览

```
src/          主 Worker 源码（fetch / queue / scheduled 三入口）
admin-ui/     管理端前端（Cloudflare Pages）
migrations/   D1 建表脚本
docs/         规范与说明
scripts/      运维脚本（创建 app、轮换密钥等）
.claude/      给 Claude Code 的项目级配置与 Skills
```

## 在线访问

### API Worker
- **Prod**：<https://aicenter-api.gv.live> / <https://ai-guard.schetkovvlad.workers.dev>
  - 健康检查：`/health`
  - **系统架构图**：[`/architecture`](https://aicenter-api.gv.live/architecture)
- **Dev**：<https://ai-guard-dev.schetkovvlad.workers.dev>

### Admin Web UI
- **默认**：<https://ai-guard-admin.pages.dev>（立即可用）
- **自定义域名**：`https://aicenter.gv.live`（等 CNAME，详见 [docs/10-admin-ui.md](docs/10-admin-ui.md)）

## 状态

MVP 已部署上线。dev + prod 环境均通过真实端到端验收：
- Grok（`grok-4-fast-non-reasoning`）：文本审核 ~500ms
- Gemini Vision（`gemini-2.5-flash`）：头像审核 ~3.5s
- 缓存命中：~400ms（无 token 消耗）
- 单元测试 21/21 pass
