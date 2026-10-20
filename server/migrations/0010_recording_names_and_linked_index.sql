-- 1) Newer Samsung firmware names recordings `Call recording <name or number>_date_time.m4a`. The matcher only
--    understood `Call <identity>_...`, so every such recording (most of them in production) stayed unlinked even though
--    its call was uniquely identifiable by time, duration and number/name. All corroboration rules are unchanged.
-- 2) "Has a recording" is answered from the recordings table through a small partial index of linked, completed,
--    not-deleted recordings, instead of probing every call.

CREATE INDEX calls_linked_idx ON calls(call_log_id)
  WHERE call_log_id IS NOT NULL AND upload_status = 'complete' AND deleted_at IS NULL;

DROP VIEW recording_call_candidates;

CREATE VIEW recording_call_candidates AS
WITH parsed AS (
  SELECT r.*,
    -- Samsung names the file either `Call <name or number>_YYMMDD_HHMMSS.m4a` or, on newer firmware,
    -- `Call recording <name or number>_YYMMDD_HHMMSS.m4a`. Both carry the same identity and timestamp.
    CASE WHEN length(display_name) > 33 AND substr(display_name, 1, 15) = 'Call recording '
      AND substr(display_name, -18, 1) = '_' AND substr(display_name, -11, 1) = '_'
      AND substr(display_name, -4) = '.m4a'
      AND substr(display_name, -17, 6) NOT GLOB '*[^0-9]*'
      AND substr(display_name, -10, 6) NOT GLOB '*[^0-9]*'
      THEN trim(substr(display_name, 16, length(display_name) - 33))
    WHEN length(display_name) > 23 AND substr(display_name, 1, 5) = 'Call '
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
  -- Every rule below needs the call to start in [media_end - duration - 31s, media_end + 1s]. Stating it lets SQLite
  -- seek call_logs by start time instead of scanning every call of similar duration; the unary + keeps the planner
  -- off the duration index. Equivalence with the previous view is covered by migration tests.
  AND unixepoch(h.started_at) BETWEEN r.media_seconds - r.duration_seconds - 31 AND r.media_seconds + 1
  AND +h.duration_seconds BETWEEN r.duration_seconds - 2 AND r.duration_seconds + 2
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

-- Link recordings that the previous definition could not read. Existing links are left alone.
UPDATE calls SET call_log_id = (
  SELECT min(c.call_log_id) FROM recording_call_candidates c WHERE c.recording_id = calls.id
  HAVING count(*) = 1 AND count(c.deleted_at) = 0
) WHERE call_log_id IS NULL AND display_name LIKE 'Call recording %';
