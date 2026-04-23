---
name: tune-prompt
description: Safely tune an ai-guard moderation prompt end-to-end (edit → dry-run → regression → publish → observe). Use when the user asks to change, adjust, improve, or experiment with a moderation prompt for any biz_type (comment/nickname/bio/avatar/…). Do NOT use for output-schema changes (those belong in src/moderation/schema.ts).
---

# Skill: 调整 Prompt 的端到端流程

## 何时触发
- 用户说"改一下评论审核的 prompt / 让 Grok 对广告更严 / 头像审核放松一点"。
- 用户说"昨天误拦了 X，prompt 怎么调"。

## 铁律（开始前必读）
- Prompt 只决定**如何判断**，不决定**输出结构**。结构由 [../../../src/moderation/schema.ts](../../../src/moderation/schema.ts) 的 Zod 锁定。
- **禁止** 在 prompt 里改 JSON 字段名 / 字段类型 / 枚举值。这些是对外契约。
- Admin UI 里保存的 prompt 不包含"输出 JSON 要求"段——那段由代码自动拼接。

## 执行步骤

### 1. 明确目标
先问用户：
- 哪个 `biz_type`？哪个 `provider`（`grok` 还是 `gemini`）？
- 要改判定哪个方向？（严格 / 宽松 / 某类违规加权）
- 有没有具体误判样例（request_id）？

### 2. 拉当前版本
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://ai-guard-dev/admin/prompts?biz_type=comment&provider=grok" | jq '.items[0]'
```
或在 Admin UI → Prompts 页导出。

### 3. 本地编辑 + diff review
- 把当前内容复制到 `/tmp/prompt-comment-grok-v7.md`。
- 改动，确保只动"判断规则"段。
- 与旧版本 diff，确认未动结构相关语句。

### 4. 干跑（dry-run）
```bash
curl -X POST https://ai-guard-dev/admin/prompts/dry-run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "biz_type":"comment",
    "provider":"grok",
    "content":"<新 prompt 原文>",
    "samples":["测试文本1","测试文本2","..."]
  }'
```
检查每条样本：
- 模型输出是否能被 Zod 解析（`schema_ok=true`）。
- 判定是否符合预期。

### 5. 回归历史样本（可选但强烈建议）
选 50-100 条最近 `moderation_requests`（尤其覆盖 pass/reject/review 三态），用 `/admin/requests/{request_id}/replay` 接口批量重跑。对比通过率 / 拒绝率变化。

### 6. 发布
```bash
curl -X POST https://ai-guard-dev/admin/prompts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"biz_type":"comment","provider":"grok","content":"<新 prompt 原文>"}'
```
服务端会：
- 写入 D1 新 version（`is_active=1`）。
- 旧版本 `is_active=0`。
- KV `PROMPTS` 在 60s 内所有边缘更新。
- `DEDUP_CACHE` **不清**（key 含 prompt_version，新请求自然 miss 走新 prompt）。

### 7. 观察 5 分钟
Admin UI → Stats 页：
- 通过率 / 错误率是否在合理范围？
- 上游延迟是否正常？
- 是否有 `status=error` 尖刺（可能是新 prompt 让模型输出偏离 JSON）？

### 8. 如果出问题：立即回滚
```bash
curl -X POST https://ai-guard-dev/admin/prompts/<old_id>/rollback \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
或 Admin UI 点"回滚到上一版本"。

## 不要做
- 不要**原地改** prompt 文件/记录——每次变更都开新 version，便于回滚和审计。
- 不要**一次改两家 provider**——Grok 和 Gemini 独立验证，否则出问题时难排查哪家的 prompt 导致。
- 不要**在业务高峰期发布**——尽量挑低峰 + 先发 dev 冒烟。
