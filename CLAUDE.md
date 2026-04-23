# ai-guard — Claude 指引

## 一句话

基于 Cloudflare Workers 的统一 AI 审核中间平台。**定位：成人男同社交 APP 的审核中间层**——合法 NSFW 内容放行，仅对 CSAM / 广告引流 / 毒品 / 赌博 / 政治敏感零容忍。对接 Grok（文本）与 Gemini（视觉），服务多个成人 APP（当前：一起看）。对外固定 JSON 契约，对内 prompt 可热更新。

## 目录速查

- [src/moderation/pipeline.ts](src/moderation/pipeline.ts) — 审核主链路编排
- [src/moderation/schema.ts](src/moderation/schema.ts) — **对外输出 Zod schema，锁死契约**
- [src/moderation/dedup.ts](src/moderation/dedup.ts) — 内容规范化 + hash + KV 去重
- [src/providers/router.ts](src/providers/router.ts) — Grok / Gemini 选路 + 熔断
- [src/callback/dispatcher.ts](src/callback/dispatcher.ts) — Queue 消费者，投递回调
- [src/auth/hmac.ts](src/auth/hmac.ts) — 入站 HMAC 校验
- [src/auth/rate-limit.ts](src/auth/rate-limit.ts) — per-app KV 滑动窗限流
- [src/alerts/telegram.ts](src/alerts/telegram.ts) — Telegram 告警（Cron 驱动）
- [src/routes/admin-*.ts](src/routes/) — Admin REST API（apps / prompts / stats）
- [admin-ui/](admin-ui/) — Cloudflare Pages 前端（React + Vite）
- [migrations/](migrations/) — D1 迁移；**只追加，不改历史**
- [docs/04-callback-spec.md](docs/04-callback-spec.md) — ★ 对外契约，改动须走评审
- [docs/apps/](docs/apps/) — 每个接入应用的专属对接文档
- [docs/optimization/](docs/optimization/) — ★ 优化任务清单（prompt / 前置漏斗 / Batch API / 物理服务器）

## 铁律

0. **平台定位：成人男同社交 APP 的审核中间层。** 合法 NSFW / 性暗示 / 裸露 / 男同色情 **绝不 reject**。仅对 CSAM（未成年性化）/ 广告引流 / 毒品 / 赌博 / 政治敏感 零容忍。编写 prompt 时必须明确这点，default prompt（migration 0001/0002）需走 P0.1 改写升级到 v3。
1. **回调 JSON schema 是对外契约。** 新增字段必须向后兼容；不得删字段或改字段含义；变更必过 [docs/04-callback-spec.md](docs/04-callback-spec.md)。
2. **Prompt 只决定"如何判断"，不决定"输出结构"。** 结构由 [src/moderation/schema.ts](src/moderation/schema.ts) 的 Zod 锁定；模型返回不合规，整条标 `status=error`。
3. **去重 KV key 必须含 `prompt_version`。** 否则 prompt 更新后旧缓存会污染结果。key 格式：`{biz_type}:{prompt_version}:{content_hash}`。
4. **Secrets 只进 wrangler secret**（`GROK_API_KEY` / `GEMINI_API_KEY` / `HMAC_MASTER`）。不入库、不入代码、不入环境变量文件。
5. **D1 迁移只追加。** 已发布的 `migrations/*.sql` 文件一律不得修改；所有 schema 变更走新文件。
6. **生产部署前必须** 通过 `pnpm -s typecheck && pnpm -s test`，且先 `--env dev` 冒烟再 `--env prod`。
7. **破坏性命令需人工确认**：`wrangler d1 execute --remote --file=drop*.sql`、`wrangler kv key delete`、任何 `rm -rf`。

## 常见任务的入口

| 任务 | 使用的 Skill |
|------|-------------|
| 新增一种审核业务类型 | `.claude/skills/add-biz-type/` |
| 调整 prompt | `.claude/skills/tune-prompt/` |
| 接入新的 AI provider | `.claude/skills/add-provider/` |
| 部署到 dev / prod | `.claude/skills/deploy-worker/` |

## 实现约定

- **语言**：TypeScript 严格模式。
- **框架**：Hono（路由） + Zod（校验）。
- **加密**：Web Crypto (`crypto.subtle`)，不引入第三方 crypto 库。
- **ID**：UUIDv7（时间序，便于 D1 按 ID 排序代替 `ORDER BY created_at`）。
- **错误响应**：统一走 [src/lib/errors.ts](src/lib/errors.ts) 的 `AppError` + 错误码枚举。
- **注释**：默认不写；只在"为什么"非显然时加一行（硬约束、外部 bug workaround 等）。
- **测试**：`vitest` + `@cloudflare/vitest-pool-workers`，覆盖 pipeline / provider / hmac / schema 四大模块。

## 沟通风格

- 回复保持简洁。
- 不要主动提交 git commit，除非用户明确要求。
- 涉及破坏性改动（改 schema / 删文件 / 改已发布 migration / 改 callback 契约）**必须先确认**。
- 更新代码后不要反复 Read 验证——harness 会标记文件状态。
