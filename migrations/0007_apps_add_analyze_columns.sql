ALTER TABLE apps ADD COLUMN analyze_biz_types         TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN delivery_mode             TEXT    NOT NULL DEFAULT 'both';
ALTER TABLE apps ADD COLUMN callback_max_concurrency  INTEGER NOT NULL DEFAULT 10;
