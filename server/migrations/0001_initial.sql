PRAGMA foreign_keys = ON;

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  token_hash TEXT NOT NULL UNIQUE,
  model TEXT,
  manufacturer TEXT,
  android_version TEXT,
  one_ui_version TEXT,
  app_version TEXT,
  pending_uploads INTEGER,
  last_successful_upload_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  fingerprint TEXT NOT NULL,
  display_name TEXT NOT NULL,
  remote_number TEXT,
  direction TEXT CHECK (direction IN ('incoming', 'outgoing', 'unknown')),
  recorded_at TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  match_status TEXT NOT NULL CHECK (match_status IN ('filename', 'media_metadata', 'call_log', 'unmatched')),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  actual_bytes INTEGER,
  object_etag TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('pending', 'complete', 'failed', 'deleted')),
  uploaded_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(device_id, fingerprint)
);

CREATE INDEX invitations_employee_idx ON invitations(employee_id, created_at DESC);
CREATE INDEX devices_employee_idx ON devices(employee_id, created_at DESC);
CREATE INDEX calls_recorded_at_idx ON calls(recorded_at DESC);
CREATE INDEX calls_employee_recorded_idx ON calls(employee_id, recorded_at DESC);
CREATE INDEX calls_remote_number_idx ON calls(remote_number);
CREATE INDEX calls_upload_status_idx ON calls(upload_status, created_at DESC);
