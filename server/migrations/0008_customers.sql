-- Customers, employee assignment and stored WhatsApp conversations. Additive only:
-- existing tables keep their data; call_logs gains two virtual (never stored) columns.

CREATE TABLE customers (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cus_*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Normalized "+<8-15 digits>"; phone_key is its last 10 digits (fewer for short numbers).
  phone TEXT NOT NULL CHECK (phone GLOB '+[0-9]*' AND length(phone) BETWEEN 9 AND 16),
  phone_key TEXT NOT NULL CHECK (length(phone_key) BETWEEN 8 AND 10),
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 1 AND 254),
  notes TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 4000),
  source TEXT CHECK (source IS NULL OR length(source) BETWEEN 1 AND 120),
  district TEXT CHECK (district IS NULL OR length(district) BETWEEN 1 AND 120),
  state TEXT CHECK (state IS NULL OR length(state) BETWEEN 1 AND 120),
  country TEXT NOT NULL DEFAULT 'India' CHECK (length(country) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

-- Archiving frees the phone number for a new customer; messages stay with the archived row.
CREATE UNIQUE INDEX customers_phone_key_live_idx ON customers(phone_key) WHERE archived_at IS NULL;
CREATE INDEX customers_live_updated_idx ON customers(updated_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE customer_employees (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, employee_id)
) WITHOUT ROWID;

CREATE INDEX customer_employees_employee_idx ON customer_employees(employee_id, customer_id);

CREATE TABLE whatsapp_messages (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wam_*'),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  external_id TEXT UNIQUE CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 256),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  message_type TEXT NOT NULL CHECK (length(message_type) BETWEEN 1 AND 40),
  body TEXT,
  media_url TEXT,
  template_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  from_number TEXT,
  to_number TEXT,
  -- UTC RFC 3339 with milliseconds, like every other timestamp; sorts lexicographically.
  sent_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  sent_by_employee_id TEXT REFERENCES employees(id),
  source TEXT NOT NULL CHECK (source IN ('import', 'app', 'provider')),
  created_at TEXT NOT NULL
);

CREATE INDEX whatsapp_messages_customer_idx ON whatsapp_messages(customer_id, sent_at DESC, id DESC);

-- Last 10 digits of call_logs.remote_number, computed by SQLite and never stored, so the
-- existing device upsert and call-history triggers are untouched. Only the common
-- presentation separators are stripped; a number containing anything else (letters, "*",
-- extensions) or fewer than 10 digits yields NULL and never matches a customer.
ALTER TABLE call_logs ADD COLUMN remote_digits TEXT GENERATED ALWAYS AS (
  replace(replace(replace(replace(replace(replace(replace(replace(remote_number,
    ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''), char(160), '')
) VIRTUAL;
ALTER TABLE call_logs ADD COLUMN phone_key TEXT GENERATED ALWAYS AS (
  CASE WHEN length(remote_digits) >= 10 AND remote_digits NOT GLOB '*[^0-9]*'
    THEN substr(remote_digits, -10) END
) VIRTUAL;

-- Customer calls are read newest-first by key without touching unrelated history.
CREATE INDEX call_logs_phone_key_idx ON call_logs(phone_key, started_at DESC, id DESC)
  WHERE deleted_at IS NULL;
