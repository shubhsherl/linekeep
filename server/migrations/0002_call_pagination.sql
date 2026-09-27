CREATE INDEX calls_sort_idx ON calls(COALESCE(recorded_at, created_at) DESC, id DESC);
CREATE INDEX calls_employee_sort_idx ON calls(employee_id, COALESCE(recorded_at, created_at) DESC, id DESC);
