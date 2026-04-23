---
name: deploy-worker
description: Deploy ai-guard Worker to dev or prod with the pre-flight checks the project requires (typecheck, test, dev smoke, migrations, tail). Use when the user asks to deploy, ship, publish, push live, or roll out the worker / admin UI. Always go dev → prod, never straight to prod.
---

# Skill: 部署 ai-guard

## 何时触发
- 用户说"部署 / 发布 / 上线 / push 到 dev / 发 prod"。
- CI 之外的手工部署。

## 铁律
- **先 dev 再 prod**，永远不要直接 `--env prod`。
- 代码改动未经 typecheck + test 不部署。
- D1 migration 先在 dev 执行并验证，再 prod。
- Secrets 不从代码读，只从 wrangler secret。

## Dev 部署流程

### 1. 预检
```bash
pnpm -s typecheck
pnpm -s test
```
任何失败 → 停，先修。不要用 `--skip-tests` 绕过。

### 2. 检查是否有新 migration
```bash
ls migrations/
wrangler d1 migrations list ai-guard --env dev
```
有新文件 → 执行：
```bash
wrangler d1 migrations apply ai-guard --env dev
```

### 3. 检查 secrets
```bash
wrangler secret list --env dev
```
确认所需 secret 都在：
- `GROK_API_KEY`
- `GEMINI_API_KEY`
- `HMAC_MASTER`

缺失 → `wrangler secret put <NAME> --env dev`。

### 4. 部署 Worker
```bash
wrangler deploy --env dev
```
记录输出的 version ID，便于回滚。

### 5. 冒烟测试
```bash
# 起 tail 观察
wrangler tail --env dev &

# 用 seed 账号打一次请求
node scripts/smoke.ts --env dev
```
`smoke.ts` 应该：
- 用 dev 的 seed app 签名发 `/v1/moderate`（文本）。
- 校验 200 响应。
- 核对回调（若 async）的 HMAC 签名。

### 6. 观察 2 分钟
Admin UI dev 环境 Stats 页：
- 是否有新增的请求？
- 延迟是否正常？
- 错误率是否 ≈ 0？

## Prod 部署流程

**仅在 dev 冒烟稳定后进行。**

### 1. 同步 migration
```bash
wrangler d1 migrations list ai-guard --env prod
wrangler d1 migrations apply ai-guard --env prod
```
⚠️ prod D1 migration 是单向的，执行前确认 SQL 内容。

### 2. 同步 secret（若有新增）
```bash
wrangler secret put <NAME> --env prod
```

### 3. 部署
```bash
wrangler deploy --env prod
```

### 4. 线上冒烟
- `wrangler tail --env prod` 观察 2 分钟。
- 挑一个非关键 app，用其 secret 打一次 `/v1/moderate`。
- 校验回调。

### 5. 看 Stats
Admin UI prod → 看最近 5 分钟：
- 请求量曲线连续。
- 错误率无尖刺。
- DLQ 无新增。

## 回滚

### Worker 回滚
```bash
wrangler rollback --env prod                      # 回到上一版
wrangler rollback --env prod --version-id <id>    # 指定版本
```

### D1 迁移不能回滚
唯一办法：**新增一个"撤销"迁移** 前滚。例如：
```sql
-- migrations/0005_undo_0004.sql
DROP TABLE foo;
```

### Admin UI 回滚
Cloudflare Pages 有原生版本管理：
```bash
wrangler pages deployment list ai-guard-admin
wrangler pages deployment rollback <deployment-id>
```

## 不要做
- 不要**用 `--force` 跳过 confirmation prompts**。
- 不要在**业务高峰** 部署 prod。
- 不要**同时发布 Worker 和 migration**；先迁 D1（向后兼容的 DDL），再发 Worker。
- 不要在 prod 直接 `wrangler d1 execute --command "..."`（settings.local.json 有 deny 规则阻拦）——走 migration。
