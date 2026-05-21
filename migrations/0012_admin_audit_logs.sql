-- Admin action audit log.
-- Best-effort operational audit for high-impact admin actions.
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  metadata_json  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_time
  ON admin_audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_logs(target_type, target_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action
  ON admin_audit_logs(action, created_at);
