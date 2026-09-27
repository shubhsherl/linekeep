CREATE TABLE call_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  started_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 0 AND 604800),
  call_type TEXT NOT NULL CHECK (call_type IN ('incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'answered_externally', 'unknown')),
  remote_number TEXT CHECK (remote_number IS NULL OR length(remote_number) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE (device_id, fingerprint)
);

CREATE INDEX call_logs_directory_idx ON call_logs(started_at DESC, id DESC);
CREATE INDEX call_logs_employee_directory_idx ON call_logs(employee_id, started_at DESC, id DESC);

-- A failed row aborts the enclosing D1 batch, including earlier upserts. These
-- guards run at persistence, after authentication and any concurrent handover.
CREATE TRIGGER call_logs_insert_guard BEFORE INSERT ON call_logs
BEGIN
  SELECT RAISE(ABORT, 'call_history_unauthorized') WHERE NOT EXISTS (
    SELECT 1 FROM devices d
    JOIN employees current ON current.id = d.employee_id
    JOIN employees historical ON historical.id = NEW.employee_id
    WHERE d.id = NEW.device_id AND d.revoked_at IS NULL
      AND current.active = 1 AND historical.active = 1
  );
  SELECT RAISE(ABORT, 'call_history_identity_conflict') WHERE EXISTS (
    SELECT 1 FROM call_logs
    WHERE device_id = NEW.device_id AND fingerprint = NEW.fingerprint
      AND started_at <> NEW.started_at
  );
END;

CREATE TRIGGER call_logs_update_guard BEFORE UPDATE ON call_logs
BEGIN
  SELECT RAISE(ABORT, 'call_history_unauthorized') WHERE NOT EXISTS (
    SELECT 1 FROM devices d
    JOIN employees current ON current.id = d.employee_id
    JOIN employees historical ON historical.id = OLD.employee_id
    WHERE d.id = OLD.device_id AND d.revoked_at IS NULL
      AND current.active = 1 AND historical.active = 1
  );
  SELECT RAISE(ABORT, 'call_history_identity_conflict')
    WHERE NEW.id <> OLD.id OR NEW.device_id <> OLD.device_id
    OR NEW.employee_id <> OLD.employee_id OR NEW.fingerprint <> OLD.fingerprint
    OR NEW.started_at <> OLD.started_at OR NEW.created_at <> OLD.created_at;
END;
