PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('linkedin','google','github','facebook','email','direct','other')),
  source_method TEXT NOT NULL CHECK (source_method IN ('utm','referrer','direct')),
  medium TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL CHECK (device IN ('mobile','tablet','desktop')),
  lang TEXT NOT NULL CHECK (lang IN ('ar','en'))
);
CREATE INDEX IF NOT EXISTS visits_time ON visits(created_at DESC);
CREATE INDEX IF NOT EXISTS visits_source_time ON visits(source,created_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('visit','project_open','cv_click','contact_click')),
  target TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_visit_time ON events(visit_id,created_at);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  error_code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notifications_due ON notifications(status,due_at);
