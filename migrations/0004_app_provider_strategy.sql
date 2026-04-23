-- 0004: per-app provider 选择策略
--   auto         — 按平台默认路由（comment/nickname/bio → grok, avatar → gemini）
--   grok         — 强制文本类使用 Grok（avatar 仍是 Gemini，Grok 无 Vision）
--   gemini       — 强制文本类使用 Gemini
--   round_robin  — 文本类在 grok/gemini 之间轮换（基于时间戳奇偶）
--
-- 说明：失败熔断逻辑不变（主失败仍切备），策略只决定"谁当主"。

ALTER TABLE apps ADD COLUMN provider_strategy TEXT NOT NULL DEFAULT 'auto';
