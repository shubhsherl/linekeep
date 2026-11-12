-- Employee web app (/app): email sign-in with one-time codes, server-side sessions, and sign-in rate counters.
-- Additive only. Nothing here stores a plain code, session token or e-mail address of someone who is not an employee.

-- An employee's sign-in address, stored lower-cased and unique among employees.
ALTER TABLE employees ADD COLUMN email TEXT;
CREATE UNIQUE INDEX employees_email_idx ON employees(lower(email)) WHERE email IS NOT NULL;

-- One row per signed-in browser. Only the HMAC of the cookie value is stored.
-- expires_at is the absolute end (12 hours); idle_expires_at slides forward while the session is used (2 hours).
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wss_*'),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL
);
CREATE INDEX web_sessions_employee_idx ON web_sessions(employee_id);

-- One-time sign-in codes. email_key is an HMAC of the lower-cased address. employee_id is NULL for a code
-- requested for an address that is no employee: that row is never sent and can never be redeemed, but it keeps the
-- request's work and response identical, so a caller cannot tell whether an address exists.
CREATE TABLE web_login_codes (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wlc_*'),
  email_key TEXT NOT NULL,
  employee_id TEXT REFERENCES employees(id),
  method TEXT NOT NULL CHECK (method IN ('email', 'whatsapp')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX web_login_codes_email_idx ON web_login_codes(email_key, created_at DESC);
CREATE INDEX web_login_codes_expiry_idx ON web_login_codes(expires_at);

-- Fixed-window counters for code requests: key is an HMAC of "email:<address>" or "ip:<address>".
CREATE TABLE web_rate_counters (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX web_rate_counters_window_idx ON web_rate_counters(window_start);
