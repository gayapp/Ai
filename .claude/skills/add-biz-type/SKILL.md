---
name: add-biz-type
description: Add a new UGC moderation business type (e.g. group message, post title) to ai-guard. Use when the user asks to support a new biz_type, register a new moderation category, or extend the four existing types (comment/nickname/bio/avatar) with another one.
---

# Skill: 新增一种审核业务类型

## 何时触发
用户说"我们要审核 X"（X 不是 comment/nickname/bio/avatar 之一），或明确要求"加一个 biz_type"。

## 前置检查
- 确认 X 的输入形态：**文本** 还是 **图片 URL**？（决定默认 provider）
- 确认 X 的典型长度和调用频率（决定是否需要特殊 rate-limit 默认值）。

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

## 验证
- 本地 `pnpm dev` → 用 [../../../scripts/seed-app.ts](../../../scripts/seed-app.ts) 造 app → curl 打 NEW_TYPE 请求 → 看 200/202 + 回调签名有效。
- Admin UI Stats 页能看到 NEW_TYPE 出现在图表 group_by 选项中。

## 不要做
- **不要** 在 Zod schema 里引入新的字段或枚举值（如新的 `status`、新 `category`），那会破坏回调契约。只加 `biz_type` 枚举值。
- **不要** 跳过 prompt 干跑（`/admin/prompts/{id}/test`）就直接发布。
