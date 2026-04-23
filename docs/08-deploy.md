# 08 · 部署手册（从 0 到线上）

本项目已完成代码 + 单测 + 打包干跑。由于你提供的 Cloudflare Token 有 **IP 白名单**，本会话运行环境 (`63.141.249.154`) 被拒绝访问账号 API，因此实际部署留待你在本地一次跑完。

## A. 一次性环境检查

```bash
node --version   # ≥ 22
pnpm --version
wrangler --version
```

## B. 解决 Token 权限（二选一）

### 选项 1：放开当前 Token 的 IP 限制
Cloudflare Dashboard → **My Profile → API Tokens** → 编辑该 Token → 把 `Client IP Address Filtering` 改为"All IPs"，或**加上你本机的出口 IP**。

### 选项 2：新建 Token（推荐，最小权限）
Dashboard → My Profile → API Tokens → **Create Token → Custom**，勾选：

**Account permissions**
- `Workers Scripts`  → Edit
- `Workers KV Storage` → Edit
- `D1` → Edit
- `Queues` → Edit
- `Account Settings` → Read

**Zone permissions**（仅当要绑自定义域名）
- `Workers Routes` → Edit

**IP Address Filtering**：留空或填你的出口 IP。

## C. 第一次部署（dev 环境）

```bash
# 在项目根目录
export CLOUDFLARE_API_TOKEN='<你的 token>'

# 1. 安装依赖（如果还没装）
pnpm install

# 2. 本地冒烟（跑单测 + 打包干跑）
pnpm typecheck && pnpm test
wrangler deploy --env dev --dry-run --outdir dist

# 3. 建 Cloudflare 资源（D1 / KV×4 / Queues），自动回填 wrangler.toml
bash scripts/bootstrap-cf.sh dev

# 4. 设置 secrets（会交互提示你粘贴值）
wrangler secret put GROK_API_KEY    --env dev
wrangler secret put GEMINI_API_KEY  --env dev
wrangler secret put ADMIN_TOKEN     --env dev   # 建议用 32 字节随机串

# 5. 部署
pnpm deploy:dev

# 6. 记下 Worker URL，形如：
#    https://ai-guard-dev.<你的 subdomain>.workers.dev
```

## D. 冒烟测试

### D.1 创建一个测试 app

```bash
BASE=https://ai-guard-dev.<你的 subdomain>.workers.dev \
  ADMIN_TOKEN=<步骤 4 里你设置的 ADMIN_TOKEN> \
  node --experimental-transform-types scripts/seed-app.ts \
    "demo-forum" "https://webhook.site/unique-id" "comment,nickname,bio,avatar"
```

输出会给你 `app_id` + `secret` + **一条可直接复制运行的 curl**。**secret 只显示这一次。**

### D.2 发一条评论审核

```bash
BASE=https://ai-guard-dev.<你的 subdomain>.workers.dev
APP_ID=app_xxx
SECRET=xxx
BODY='{"biz_type":"comment","biz_id":"c-1","content":"你好世界"}'

eval $(node scripts/sign-request.mjs "$APP_ID" "$SECRET" "$BODY")

curl -s "$BASE/v1/moderate" \
  -H "x-app-id: $X_APP_ID" \
  -H "x-timestamp: $X_TS" \
  -H "x-nonce: $X_NONCE" \
  -H "x-signature: $X_SIG" \
  -H "content-type: application/json" \
  -d "$X_BODY" | jq
```

预期：`200 { "request_id": ..., "cached": false, "result": { "status": "pass", ... } }`

**再跑一次**同样的命令 → `cached: true`，且延迟 < 50ms。

### D.3 头像（异步）

```bash
BODY='{"biz_type":"avatar","biz_id":"av-1","content":"https://picsum.photos/400"}'
eval $(node scripts/sign-request.mjs "$APP_ID" "$SECRET" "$BODY")
curl -s "$BASE/v1/moderate" -H "x-app-id: $X_APP_ID" -H "x-timestamp: $X_TS" \
  -H "x-nonce: $X_NONCE" -H "x-signature: $X_SIG" \
  -H "content-type: application/json" -d "$X_BODY" | jq
```

预期：`202 { "request_id": ..., "accepted_at": "..." }`
然后在你的 `callback_url`（webhook.site）收到带 `X-Signature` header 的 POST 回调。

### D.4 Admin API（看统计）

```bash
curl -s "$BASE/admin/stats/summary" \
  -H "authorization: Bearer <ADMIN_TOKEN>" | jq
```

## E. 生产部署

```bash
# 1. 资源
bash scripts/bootstrap-cf.sh prod

# 2. secrets
wrangler secret put GROK_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put ADMIN_TOKEN

# 3. 部署
pnpm deploy:prod
```

> prod 和 dev 完全独立：独立 D1 / 独立 KV / 独立 Queues / 独立 Worker URL。prompt 也要单独发一次（`POST /admin/prompts`），或从 dev 的 Admin API 导出再推到 prod。

## F. 自定义域名（可选）

Dashboard → Workers & Pages → 选中 `ai-guard` → Settings → Triggers → **Add Custom Domain** → 输入 `ai-guard.yourcompany.com`（需要该域名已在 CF 托管）。

之后应用侧把 `BASE` 换成自定义域名即可。

## G. 升级流程

```bash
# 日常代码改动
pnpm typecheck && pnpm test

# 如果加了 migration
ls migrations/    # 确认新文件是 NNNN_xxx.sql 格式
wrangler d1 migrations apply ai-guard --env dev --remote
# 验收后
wrangler d1 migrations apply ai-guard --remote

# 发布
pnpm deploy:dev
# ... 冒烟 ...
pnpm deploy:prod
```

遇到问题回滚：`wrangler rollback --env prod`。

## H. 本地开发（无需部署）

```bash
cp .dev.vars.example .dev.vars   # 填 Grok/Gemini key
wrangler d1 migrations apply ai-guard --local
pnpm dev
# Worker 在 http://127.0.0.1:8787
```

Seed：
```bash
BASE=http://127.0.0.1:8787 ADMIN_TOKEN=dev-admin-token \
  node --experimental-transform-types scripts/seed-app.ts
```
