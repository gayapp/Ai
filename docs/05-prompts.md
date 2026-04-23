# 05 · Prompt 调整规范

## 核心原则

**Prompt 只决定"如何判断"，不决定"输出结构"。**

输出结构由 [../src/moderation/schema.ts](../src/moderation/schema.ts) 的 Zod schema 锁死。模型返回不合规时，整条被标 `status=error`，不会穿透到应用端。因此运营可以放心调 prompt 的**判断规则**，无需担心破坏回调契约。

## Prompt 的作用范围

| 可以影响 | 不能影响 |
|---------|---------|
| 什么算"违规" | 输出字段名 |
| 风险等级如何判定 | 字段类型 |
| 哪些 category 优先 | 枚举允许值 |
| 语气 / 判定尺度松紧 | 是否必填 |

## Prompt 结构约定

每个 prompt 建议分四段：

```
# 角色
你是一个内容审核助手，负责审核 {biz_type}。

# 判断规则
{具体规则列表，每条一句，分点写}

# 输出要求（⚠️ 此段由代码层生成，请勿在 Admin UI 修改）
必须返回严格 JSON：
{
  "status": "pass" | "reject" | "review",
  "risk_level": "safe" | "low" | "medium" | "high",
  "categories": ["politics" | "porn" | "abuse" | "ad" | "spam" | "violence" | "other"],
  "reason": "string"
}

# 待审核内容
{content}
```

> 代码在调模型前会**自动拼接"输出要求"这一段**（从 schema.ts 生成 JSON Schema 描述）。管理端里只保存前两段 + 最后一段的模板，即"角色 + 判断规则 + 待审内容占位"。

## 热更新流程

1. 在 Admin UI → Prompts 页选择 `biz_type` + `provider`，看当前 active 版本。
2. 点"新版本"，基于当前内容编辑。
3. 点"干跑"（调 `POST /admin/prompts/{id}/test`）用几条样本测。
4. 点"发布"：
   - D1 写入新 version，`is_active=1`，老版本 `is_active=0`。
   - `PROMPTS` KV 自动失效（TTL 60s，1 分钟内全边缘生效）。
   - `DEDUP_CACHE` **不清**：dedup key 含 `prompt_version`，新请求自然 miss 缓存走新 prompt；老的缓存随 TTL 自然消失。
5. 观察 Stats 页的通过率/错误率 5 分钟。
6. 出问题 → Prompts 页点"回滚"（激活上一个版本）。

## 写 prompt 的建议

- **规则具体到可检**：与其"不得包含不良信息"，不如列"色情暗示 / 脏话 / 辱骂他人 / 广告联系方式"。
- **明确灰色地带的处理**：写清什么情况下用 `review` 而不是 `reject`。
- **避免例外**：尽量不写"除非…"类的 clause，难以稳定执行。
- **不要在 prompt 中谈 JSON 结构**：code 层会拼接。你在 prompt 里谈 JSON 反而容易让模型自由发挥。

## Prompt 版本管理

- 所有版本永久保存在 D1（仅内容，不含 KV 缓存）。
- 可以任意时刻 rollback 到旧版本——D1 把 `is_active` 挪到目标版本即可。
- **切忌同版本号反复修改**——每次改动都要新开 version。UI 默认强制新版本，不允许原地编辑。

## 路由到 provider 的影响

- 同一 biz_type 下，`grok` 和 `gemini` 有**独立的 prompt 版本**。
- 熔断切换 provider 时会用对应 provider 的 active prompt。
- 两套 prompt 的风格可以不同（Grok 偏中文口语、Gemini 稍正式），但**判定标准必须对齐**，否则统计口径会漂移。

## 评估回归

当改动比较大时，建议用"回放"（`POST /admin/requests/{request_id}/replay`）在 50-100 条历史样本上跑一轮，对比通过率 / 错误率变化。见 [.claude/skills/tune-prompt/](../.claude/skills/tune-prompt/SKILL.md) 的完整流程。
