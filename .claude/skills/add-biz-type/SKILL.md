---
name: add-biz-type
description: Add a new ai-guard biz_type. Use when the user asks to support a new moderate biz_type (UGC审核) or analyze biz_type (内容服务), and choose the correct track before editing code.
---

# Skill: 新增一种业务类型

## 何时触发

用户说"我们要支持 X"、"我们要审核 X"、"加一个 biz_type"，或要求接入新的内容分析 / 生成能力。

## 前置检查
- 先选择 track：**moderate 系**还是 **analyze 系**。
- 确认 X 的输入形态：文本、图片 URL、结构化 object、多图、多模态。
- 确认输出形态：审核判定字段，还是 biz_type 专属 `result` object。
- 确认典型长度、调用频率、是否必须异步、是否需要 pull 交付。

## Track A: moderate 系 biz_type

适用：新增 UGC 审核类型，输出仍必须是 [../../../docs/04-callback-spec.md](../../../docs/04-callback-spec.md) 的固定字段：`status` / `risk_level` / `categories` / `reason`。

## 执行步骤

### 1. 扩展 Zod 枚举
编辑 [../../../src/moderation/schema.ts](../../../src/moderation/schema.ts)：
```ts
export const BizType = z.enum(["comment", "nickname", "bio", "avatar", "NEW_TYPE"]);
```
注意：枚举值一旦上线不可删（属对外契约）。

### 2. 配置 provider 路由
编辑 [../../../src/providers/router.ts](../../../src/providers/router.ts)，在 `routeMap` 中追加：
```ts
NEW_TYPE: { primary: "grok", fallback: "gemini" }   // 或反之（图片类）
```

### 3. 写初版 prompt（2 份，grok + gemini 各 1）
**不要**直接改 D1 里的 prompt 表。走 Admin API：
```bash
curl -X POST https://ai-guard-dev/admin/prompts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"biz_type":"NEW_TYPE","provider":"grok","content":"..."}'
```
Prompt 写法参见 [../../../docs/05-prompts.md](../../../docs/05-prompts.md)。

### 4. 无需 D1 migration
`biz_type` 字段已是 TEXT，不需要 schema 变更。

### 5. 文档与测试
- 更新 [../../../docs/00-overview.md](../../../docs/00-overview.md) 的"支持的业务类型"表。
- 更新 [../../../docs/02-api-public.md](../../../docs/02-api-public.md) 的 biz_type 列表。
- 在 `src/moderation/__tests__/` 下加 e2e：提交一条 NEW_TYPE 请求，校验通过/拒绝两条样本的回调结构。

### 6. 开放给 app
给目标 app 的 `biz_types` 字段追加新值（Admin API `PATCH /admin/apps/{id}`）。

## Track A 验证
- 本地 `pnpm dev` → 用 [../../../scripts/seed-app.ts](../../../scripts/seed-app.ts) 造 app → curl 打 NEW_TYPE 请求 → 看 200/202 + 回调签名有效。
- Admin UI Stats 页能看到 NEW_TYPE 出现在图表 group_by 选项中。

## Track A 不要做
- **不要** 在 Zod schema 里引入新的字段或枚举值（如新的 `status`、新 `category`），那会破坏回调契约。只加 `biz_type` 枚举值。
- **不要** 跳过 prompt 干跑（`/admin/prompts/{id}/test`）就直接发布。

## Track B: analyze 系 biz_type

适用：新增内容分析 / 内容生成能力，输入是结构化 `input` object，输出是 biz_type 专属 `result` object，通过 `/v1/analyze` 交付。

### 1. 确认契约边界

- 端点固定为 `POST /v1/analyze`。
- callback 契约固定走 [../../../docs/13-callback-spec-analyze.md](../../../docs/13-callback-spec-analyze.md)。
- pull / ack 契约固定走 [../../../docs/14-analyze-records.md](../../../docs/14-analyze-records.md)。
- 不修改 [../../../docs/04-callback-spec.md](../../../docs/04-callback-spec.md)。
- `analyze_requests.input_json` 与 `result_json` 长保留，不参与 moderate TTL。

如果要改变端点、callback envelope、留存策略或交付模式，先开 ADR，不要直接实现。

### 2. 扩展 analyze 枚举与 envelope

编辑 analyze 线 schema，例如：

- `src/analyze/schema/envelope.ts`
- `src/analyze/types.ts`

新增 biz_type 只能进入 analyze 枚举，不要加入 `src/moderation/schema.ts`。

### 3. 新增 biz_type 专属 Input / Output Zod

在 `src/analyze/schema/NEW_TYPE.ts` 建立：

```ts
export const NewTypeInput = z.object({ /* input object */ });
export const NewTypeOutput = z.object({ /* result object */ });
```

Output 是对外契约。上线后只能向后兼容演进，不能删除字段或改变含义。

### 4. 新增 pipeline dispatcher 分支

编辑：

- `src/analyze/pipeline/dispatcher.ts`
- `src/analyze/pipeline/NEW_TYPE.ts`

pipeline 至少包含：

- input 二次校验
- canonical JSON + `input_hash`
- KV dedup key `{biz_type}:{prompt_version}:{input_hash}`
- provider 调用
- Output Zod 校验
- 写 `analyze_requests.result_json`
- 按 `delivery_mode ∈ {callback, pull, both}` 交付

### 5. 配置 provider 路由

编辑 [../../../src/providers/router.ts](../../../src/providers/router.ts)，为 analyze biz_type 增加主备 provider。熔断 key 必须按 `(provider, biz_type)` 隔离，避免 analyze 故障影响 moderate。

### 6. 写 prompt seed 或走 Admin API

如果需要随 migration seed 初始 prompt，新增 `migrations/00XX_seed_NEW_TYPE_prompt.sql`。否则走 Admin API 发布 prompt。

Prompt 只约束模型行为，不决定 callback envelope。result 结构由 Zod schema 锁定。

### 7. 文档与测试

- 更新 [../../../docs/12-content-service.md](../../../docs/12-content-service.md) 的 biz_type 表和 schema。
- 更新 [../../../docs/13-callback-spec-analyze.md](../../../docs/13-callback-spec-analyze.md) 的 result schema 链接。
- 更新 [../../../docs/02-api-public.md](../../../docs/02-api-public.md) 的 `/v1/analyze` biz_type 列表。
- 增加 route / pipeline / callback / pull 测试。

### 8. 开放给 app

给目标 app 的 `analyze_biz_types` 字段追加新值。按场景设置：

- `delivery_mode="callback"`：只推 callback
- `delivery_mode="pull"`：只拉取，不推 callback
- `delivery_mode="both"`：默认推荐，callback + pull 兜底

## Track B 验证

- `pnpm -s typecheck && pnpm -s test`
- 涉及 D1 时执行 `wrangler d1 execute --local --file=migrations/00XX_*.sql`
- 合法 HMAC 调 `POST /v1/analyze`，确认 D1 写入完整 `input_json`
- callback body 为 `schema_version="1.1"`，`status ∈ {"ok","error"}`，成功时有 `result`
- `delivery_mode="pull"` 不投递 callback，`GET /v1/analyze` 可拉取，ack 幂等
- moderate 回归测试仍 100% 通过，moderate callback 不出现 `result`

## Choose track

```
新需求是 UGC 审核吗？
├─ 是：走 Track A moderate
│  ├─ 输入必须能收敛为 content: string
│  ├─ 输出必须仍是 status/risk_level/categories/reason
│  └─ 只改 moderate schema、provider route、prompt、docs、tests
└─ 否：它是内容分析 / 内容生成 / 多模态结构化任务吗？
   ├─ 是：走 Track B analyze
   │  ├─ 输入是 input: object
   │  ├─ 输出是 result: object
   │  ├─ 使用 /v1/analyze + analyze_requests
   │  └─ 支持 delivery_mode callback|pull|both
   └─ 不确定：
      ├─ 先读 docs/optimization/content-services-expansion.md §3-§9
      ├─ 仍模糊就开 ADR
      └─ 不要即兴改变端点、schema、留存策略或交付模式
```
