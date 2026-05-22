-- Prompt regression sample sets for admin-side draft vs active prompt checks.
CREATE TABLE IF NOT EXISTS prompt_regression_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  biz_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_regression_route
  ON prompt_regression_sets (biz_type, provider, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompt_regression_updated
  ON prompt_regression_sets (updated_at DESC);
