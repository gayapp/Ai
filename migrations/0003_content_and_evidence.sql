-- 0003: admin 详情页需要看到用户提交的原文 / 图片证据。
--   content_text  — 原始内容（文本正文 或 图片 URL），仅用于运维排查
--   evidence_key  — 头像审核时保存到 R2 的对象 key（nullable）
--
-- 90 天随明细自动清理（scheduled cleanup 已有）。

ALTER TABLE moderation_requests ADD COLUMN content_text TEXT;
ALTER TABLE moderation_requests ADD COLUMN evidence_key TEXT;
