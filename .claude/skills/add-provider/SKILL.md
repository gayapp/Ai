---
name: add-provider
description: Wire a new upstream AI provider (e.g. Claude, Qwen, DeepSeek, Gemini model variant) into ai-guard's provider router. Use when the user asks to integrate another model, add a backup provider, or support a new LLM vendor beyond the existing Grok + Gemini.
---

# Skill: 接入新的 AI Provider

## 何时触发
- 用户说"加一个 Claude / Qwen / DeepSeek / Kimi 作为兜底 / 新主"。
- 用户说"把评论审核的主 provider 换成 X"。

## 设计前提
Provider 通过 `ProviderAdapter` 接口解耦，新增只改一个文件 + router 配置，不动 pipeline / schema / dedup。

## 执行步骤

### 1. 确认 API 契约
了解上游：
- 鉴权方式（Bearer key / signed requests / OAuth）
- Chat completion 端点（URL、method、请求结构）
- 是否支持图片（决定能否用于 `avatar`）
- Token 计费口径（`input_tokens` / `output_tokens` 如何读取）
- 速率限制（QPS / TPM）
- JSON 模式 / structured output 支持情况

### 2. 新增 `src/providers/<name>.ts`
参考 [../../../src/providers/grok.ts](../../../src/providers/grok.ts)（或 gemini.ts）实现。

必须实现的接口（Phase 1 定义在 [../../../src/providers/router.ts](../../../src/providers/router.ts)）：
```ts
export interface ProviderAdapter {
  id: "grok" | "gemini" | "claude" | "qwen" | "deepseek";
  moderate(args: {
    prompt: string;
    content: string | ImageRef;
    timeoutMs: number;
  }): Promise<{
    rawText: string;            // 模型原始文本输出
    model: string;              // 具体模型 ID，便于审计
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}
```

要点：
- 超时用 `AbortSignal.timeout(timeoutMs)`。
- 错误统一抛 `ProviderError(code, upstream)`——code 使用 [../../../src/lib/errors.ts](../../../src/lib/errors.ts) 的枚举。
- **不要** 在 provider 内做 JSON 解析 / Zod 校验——那是 pipeline 的职责。
- **不要** 直接读 env；通过参数注入（便于测试 mock）。

### 3. 注册到 router
编辑 [../../../src/providers/router.ts](../../../src/providers/router.ts)：
```ts
const ADAPTERS: Record<string, ProviderAdapter> = {
  grok:    createGrokAdapter(env.GROK_API_KEY),
  gemini:  createGeminiAdapter(env.GEMINI_API_KEY),
  claude:  createClaudeAdapter(env.CLAUDE_API_KEY),   // 新增
};
```
如果要把新 provider 设为某 biz_type 的主/备，也改 `routeMap`。

### 4. 加 secret
```bash
wrangler secret put CLAUDE_API_KEY --env dev
wrangler secret put CLAUDE_API_KEY --env prod
```
同时在 [../../../src/env.d.ts](../../../src/env.d.ts) 的 `Env` 类型里声明 `CLAUDE_API_KEY: string`。

### 5. 更新 Zod 枚举
在 [../../../src/moderation/schema.ts](../../../src/moderation/schema.ts)：
```ts
export const Provider = z.enum(["grok", "gemini", "claude"]);
```
这个值会出现在回调 JSON 的 `provider` 字段——属向后兼容变更（新增枚举值，应用端会当 `other` 处理）。

### 6. 写初版 prompt
为这个 provider × biz_type 组合写 prompt（走 Admin API `POST /admin/prompts`）。注意不同模型风格差异（例 Claude 喜欢 XML 标签，Qwen 中文风格略正式）。

### 7. 测试
- 单元测试：mock 上游响应，验证 adapter 的请求构造和响应解析。
- 集成测试：实打一次 dev 环境，看 D1 / 回调是否正常。
- 熔断测试：强制 provider 失败 3 次，验证自动切备。

### 8. 文档
- 更新 [../../../docs/01-architecture.md](../../../docs/01-architecture.md) 的"技术栈"和"Provider Router"表。
- 如果改了默认路由，更新 [../../../docs/00-overview.md](../../../docs/00-overview.md) 的 biz_type 表。

## 不要做
- 不要**绕过 router** 直接在 pipeline 里调上游——否则熔断/统计会失效。
- 不要**复用现有 provider 的 secret**——一家一个 key，方便轮换。
- 不要**把 provider-specific JSON schema 写进 src/moderation/schema.ts**——schema 是对外契约，与 provider 无关。
