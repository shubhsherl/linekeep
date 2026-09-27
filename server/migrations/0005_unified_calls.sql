ALTER TABLE call_logs ADD COLUMN caller_name TEXT CHECK (caller_name IS NULL OR length(caller_name) BETWEEN 1 AND 256);
ALTER TABLE call_logs ADD COLUMN local_number TEXT CHECK (local_number IS NULL OR length(local_number) BETWEEN 1 AND 80);
ALTER TABLE call_logs ADD COLUMN sim_label TEXT CHECK (sim_label IS NULL OR length(sim_label) BETWEEN 1 AND 120);
ALTER TABLE call_logs ADD COLUMN phone_account_id TEXT CHECK (phone_account_id IS NULL OR length(phone_account_id) BETWEEN 1 AND 256);
ALTER TABLE calls ADD COLUMN call_log_id TEXT REFERENCES call_logs(id) ON DELETE SET NULL;

CREATE INDEX call_logs_association_idx ON call_logs(device_id, employee_id, substr(started_at, 1, 19), duration_seconds);
CREATE INDEX calls_association_idx ON calls(device_id, employee_id, substr(recorded_at, 1, 19), duration_seconds);
CREATE INDEX calls_history_idx ON calls(call_log_id, upload_status);
CREATE INDEX calls_unlinked_directory_idx ON calls(COALESCE(recorded_at, created_at) DESC, id DESC) WHERE call_log_id IS NULL;

-- Resolve against the full history, never the filtered/paginated administrator view.
-- A scalar aggregate with HAVING yields NULL for zero or multiple candidates.
CREATE TRIGGER calls_link_insert AFTER INSERT ON calls
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER calls_link_metadata AFTER UPDATE OF recorded_at, duration_seconds, remote_number ON calls
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER call_logs_link_insert AFTER INSERT ON call_logs
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1
  ) WHERE device_id = NEW.device_id AND employee_id = NEW.employee_id
    AND substr(recorded_at, 1, 19) = substr(NEW.started_at, 1, 19) AND duration_seconds = NEW.duration_seconds;
END;

CREATE TRIGGER call_logs_link_update AFTER UPDATE OF duration_seconds, call_type, remote_number ON call_logs
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1
  ) WHERE device_id = NEW.device_id AND employee_id = NEW.employee_id
    AND substr(recorded_at, 1, 19) = substr(NEW.started_at, 1, 19)
    AND duration_seconds IN (OLD.duration_seconds, NEW.duration_seconds);
END;

CREATE TRIGGER call_logs_link_delete AFTER DELETE ON call_logs
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1
  ) WHERE device_id = OLD.device_id AND employee_id = OLD.employee_id
    AND substr(recorded_at, 1, 19) = substr(OLD.started_at, 1, 19) AND duration_seconds = OLD.duration_seconds;
END;

UPDATE calls SET call_log_id = (
  SELECT min(h.id) FROM call_logs h
  WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
    AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
    AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
    AND h.call_type IN ('incoming', 'outgoing')
    AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
  HAVING count(*) = 1
);

ALTER TABLE devices ADD COLUMN invitation_id TEXT REFERENCES invitations(id);
ALTER TABLE devices ADD COLUMN last_invitation_id TEXT REFERENCES invitations(id);
ALTER TABLE invitations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'enrollment' CHECK (purpose IN ('enrollment', 'recovery'));
ALTER TABLE invitations ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE invitations ADD COLUMN recovery_device_id TEXT REFERENCES devices(id);
ALTER TABLE invitations ADD COLUMN recovery_assigned_at TEXT;
CREATE INDEX invitations_recovery_idx ON invitations(recovery_device_id) WHERE redeemed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX devices_live_directory_idx ON devices(created_at DESC, id DESC) WHERE revoked_at IS NULL;
CREATE INDEX devices_employee_live_directory_idx ON devices(employee_id, created_at DESC, id DESC) WHERE revoked_at IS NULL;
CREATE INDEX invitations_live_directory_idx ON invitations(employee_id, created_at DESC, id DESC) WHERE revoked_at IS NULL;

-- Only a unique match in BOTH directions proves legacy provenance. Use the
-- initial employee assignment, not the device's possibly reassigned employee.
UPDATE invitations SET device_id = (
  SELECT d.id FROM devices d JOIN device_assignments a ON a.device_id = d.id AND a.is_initial = 1
  WHERE a.employee_id = invitations.employee_id AND d.created_at = invitations.redeemed_at
) WHERE redeemed_at IS NOT NULL
AND (SELECT count(*) FROM devices d JOIN device_assignments a ON a.device_id = d.id AND a.is_initial = 1
  WHERE a.employee_id = invitations.employee_id AND d.created_at = invitations.redeemed_at) = 1
AND (SELECT count(*) FROM invitations other
  WHERE other.employee_id = invitations.employee_id AND other.redeemed_at = invitations.redeemed_at) = 1;
UPDATE devices SET invitation_id = (SELECT id FROM invitations WHERE device_id = devices.id),
  last_invitation_id = (SELECT id FROM invitations WHERE device_id = devices.id)
WHERE EXISTS (SELECT 1 FROM invitations WHERE device_id = devices.id);
