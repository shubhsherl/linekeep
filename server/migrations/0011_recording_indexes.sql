-- Four calls indexes were never used by any query: recordings are ordered by COALESCE(recorded_at, created_at)
-- (calls_sort_idx), not by recorded_at; the number filter is a LIKE '%...%' that no index can serve; and
-- calls_upload_status_idx (upload_status, created_at) was chosen for status = 'complete' (scanning most of the
-- table) while its created_at order matched no query. Each costs a write per recording insert.
DROP INDEX calls_recorded_at_idx;
DROP INDEX calls_employee_recorded_idx;
DROP INDEX calls_remote_number_idx;
DROP INDEX calls_upload_status_idx;

-- One index for "recordings in this status, newest first" and for the retention job ("complete and older
-- than N days, oldest first"). Without it the job walked every already-deleted recording before reaching the
-- next expired one, so it got slower every day.
CREATE INDEX calls_status_sort_idx ON calls(upload_status, COALESCE(recorded_at, created_at) DESC, id DESC);
