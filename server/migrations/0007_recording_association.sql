-- Samsung samples use Call <contact-or-number>_YYMMDD_HHMMSS.m4a.
-- Their embedded media date is the END, while the filename is the recording
-- start, a few seconds after Android's call start (ringing). Preserve all raw
-- metadata. Never use upload time, file modification time, or a guessed zone.
DROP TRIGGER calls_link_insert;
DROP TRIGGER calls_link_metadata;
DROP TRIGGER call_logs_link_insert;
DROP TRIGGER call_logs_link_update;
DROP INDEX call_logs_association_idx;
DROP INDEX calls_association_idx;

CREATE INDEX call_logs_duration_match_idx ON call_logs(device_id, employee_id, duration_seconds);
CREATE INDEX calls_duration_match_idx ON calls(device_id, employee_id, duration_seconds);

-- One candidate definition serves backfill and every arrival/update path.
-- Tombstones remain candidates; deletion must never resolve ambiguity.
CREATE VIEW recording_call_candidates AS
WITH parsed AS (
  SELECT r.*,
    CASE WHEN length(display_name) > 23 AND substr(display_name, 1, 5) = 'Call '
      AND substr(display_name, -18, 1) = '_' AND substr(display_name, -11, 1) = '_'
      AND substr(display_name, -4) = '.m4a'
      AND substr(display_name, -17, 6) NOT GLOB '*[^0-9]*'
      AND substr(display_name, -10, 6) NOT GLOB '*[^0-9]*'
      THEN trim(substr(display_name, 6, length(display_name) - 23)) END AS filename_identity,
    '20' || substr(display_name, -17, 2) || '-' || substr(display_name, -15, 2) || '-' ||
      substr(display_name, -13, 2) || 'T' || substr(display_name, -10, 2) || ':' ||
      substr(display_name, -8, 2) || ':' || substr(display_name, -6, 2) AS filename_date
  FROM calls r
), recordings AS (
  SELECT parsed.*, unixepoch(recorded_at) AS media_seconds,
    unixepoch(filename_date) AS filename_seconds,
    replace(replace(replace(replace(replace(replace(remote_number, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') AS number_key,
    replace(replace(replace(replace(replace(replace(filename_identity, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') AS filename_number_key
  FROM parsed
), history AS (
  SELECT h.*,
    replace(replace(replace(replace(replace(replace(remote_number, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') AS number_key
  FROM call_logs h
)
SELECT r.id AS recording_id, h.id AS call_log_id, h.deleted_at
FROM recordings r JOIN history h
  ON h.device_id = r.device_id AND h.employee_id = r.employee_id
  AND h.duration_seconds BETWEEN r.duration_seconds - 2 AND r.duration_seconds + 2
WHERE r.duration_seconds > 0 AND h.duration_seconds > 0
  AND h.call_type IN ('incoming', 'outgoing')
  AND (r.direction IS NULL OR r.direction = 'unknown' OR r.direction = h.call_type)
  AND (h.remote_number IS NULL OR r.remote_number IS NULL OR h.remote_number = r.remote_number
    OR (length(r.number_key) BETWEEN 7 AND 15 AND r.number_key NOT GLOB '*[^0-9]*' AND r.number_key = h.number_key))
  AND (
    -- Retain exact source-start matching for other recording conventions.
    (r.filename_identity IS NULL AND h.duration_seconds = r.duration_seconds
      AND substr(h.started_at, 1, 19) = substr(r.recorded_at, 1, 19))
    OR (
      -- Names are exact (ASCII case-insensitive); telephone formatting may vary,
      -- but never guess a country code or compare only the final digits.
      r.filename_identity IS NOT NULL
      AND (r.filename_identity = trim(h.caller_name) COLLATE NOCASE
        OR (length(r.filename_number_key) BETWEEN 7 AND 15
          AND r.filename_number_key NOT GLOB '*[^0-9]*' AND r.filename_number_key = h.number_key))
      AND strftime('%Y-%m-%dT%H:%M:%S', r.filename_seconds, 'unixepoch') = r.filename_date
      AND (
        -- Corroborate filename wall time against either embedded start or end.
        -- A valid UTC offset lies in -12h..+14h on a 15-minute boundary; allow
        -- only two seconds of rounding. No device/server timezone assumption.
        (r.media_seconds - unixepoch(h.started_at) BETWEEN 0 AND 30
          AND r.filename_seconds - r.media_seconds BETWEEN -43202 AND 50402
          AND abs((r.filename_seconds - r.media_seconds)
            - round((r.filename_seconds - r.media_seconds) / 900.0) * 900) <= 2)
        OR
        (r.media_seconds - r.duration_seconds - unixepoch(h.started_at) BETWEEN 0 AND 30
          AND r.filename_seconds - (r.media_seconds - r.duration_seconds) BETWEEN -43202 AND 50402
          AND abs((r.filename_seconds - (r.media_seconds - r.duration_seconds))
            - round((r.filename_seconds - (r.media_seconds - r.duration_seconds)) / 900.0) * 900) <= 2)
      )
    )
  );

CREATE TRIGGER calls_link_insert AFTER INSERT ON calls
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
    HAVING count(*) = 1 AND count(c.deleted_at) = 0
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER calls_link_metadata AFTER UPDATE OF recorded_at, duration_seconds, remote_number, direction, display_name ON calls
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
    HAVING count(*) = 1 AND count(c.deleted_at) = 0
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER call_logs_link_insert AFTER INSERT ON call_logs
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
    HAVING count(*) = 1 AND count(c.deleted_at) = 0
  ) WHERE device_id = NEW.device_id AND employee_id = NEW.employee_id
    AND duration_seconds BETWEEN NEW.duration_seconds - 2 AND NEW.duration_seconds + 2;
END;

CREATE TRIGGER call_logs_link_update AFTER UPDATE OF duration_seconds, call_type, remote_number, caller_name ON call_logs
BEGIN
  UPDATE calls SET call_log_id = (
    SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
    HAVING count(*) = 1 AND count(c.deleted_at) = 0
  ) WHERE device_id = NEW.device_id AND employee_id = NEW.employee_id
    AND (duration_seconds BETWEEN OLD.duration_seconds - 2 AND OLD.duration_seconds + 2
      OR duration_seconds BETWEEN NEW.duration_seconds - 2 AND NEW.duration_seconds + 2);
END;

-- Existing clients and already-uploaded audio benefit without re-uploading.
UPDATE calls SET call_log_id = (
  SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
  HAVING count(*) = 1 AND count(c.deleted_at) = 0
);
