-- 0005: 前置漏斗观测字段
--   prefiltered_by  — 记录命中的漏斗层：
--                      'low_signal'       (L1 低信噪短路 pass)
--                      'ad:<rule_name>'   (L2 高置信广告黑名单 reject)
--                      null               (没命中漏斗，走了模型)

ALTER TABLE moderation_requests ADD COLUMN prefiltered_by TEXT;
