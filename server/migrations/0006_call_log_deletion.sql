ALTER TABLE call_logs ADD COLUMN deleted_at TEXT;

-- History tombstones retain their fingerprint and matching evidence. Device replay
-- cannot change them; administrator deletion does not require an active device.
DROP TRIGGER call_logs_update_guard;
CREATE TRIGGER call_logs_update_guard BEFORE UPDATE OF
  id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type,
  remote_number, created_at, caller_name, local_number, sim_label, phone_account_id ON call_logs
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

CREATE TRIGGER call_logs_tombstone_guard BEFORE UPDATE ON call_logs
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'call_history_deleted');
END;

CREATE TRIGGER call_logs_unlink_deleted AFTER UPDATE OF deleted_at ON call_logs
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE calls SET call_log_id = NULL WHERE call_log_id = NEW.id;
END;

-- Count ALL matching history, including tombstones. A unique candidate can be
-- linked only if it is live: removing history must never resolve ambiguity.
DROP TRIGGER calls_link_insert;
DROP TRIGGER calls_link_metadata;
DROP TRIGGER call_logs_link_insert;
DROP TRIGGER call_logs_link_update;
DROP TRIGGER call_logs_link_delete;

CREATE TRIGGER calls_link_insert AFTER INSERT ON calls
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(h.id) FROM call_logs h
    WHERE h.device_id = calls.device_id AND h.employee_id = calls.employee_id
      AND substr(h.started_at, 1, 19) = substr(calls.recorded_at, 1, 19)
      AND h.duration_seconds = calls.duration_seconds AND calls.duration_seconds > 0
      AND h.call_type IN ('incoming', 'outgoing')
      AND (h.remote_number IS NULL OR calls.remote_number IS NULL OR h.remote_number = calls.remote_number)
    HAVING count(*) = 1 AND count(h.deleted_at) = 0
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
    HAVING count(*) = 1 AND count(h.deleted_at) = 0
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
    HAVING count(*) = 1 AND count(h.deleted_at) = 0
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
    HAVING count(*) = 1 AND count(h.deleted_at) = 0
  ) WHERE device_id = NEW.device_id AND employee_id = NEW.employee_id
    AND substr(recorded_at, 1, 19) = substr(NEW.started_at, 1, 19)
    AND duration_seconds IN (OLD.duration_seconds, NEW.duration_seconds);
END;

-- A physical maintenance deletion is not a user operation. Do not promote a
-- surviving ambiguous candidate when matching evidence is removed out of band.
