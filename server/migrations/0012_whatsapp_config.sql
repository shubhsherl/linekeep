-- Dashboard-managed WhatsApp behaviour: automatic replies to matching customer messages, and quick messages that
-- employees insert into a chat. Additive only.

CREATE TABLE whatsapp_auto_replies (
  id TEXT PRIMARY KEY CHECK (id GLOB 'war_*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  match_type TEXT NOT NULL CHECK (match_type IN ('contains', 'exact', 'starts_with')),
  -- JSON array of normalized (lower-case, single-spaced) keywords.
  keywords TEXT NOT NULL CHECK (json_valid(keywords) AND json_type(keywords) = 'array'),
  reply_type TEXT NOT NULL CHECK (reply_type IN ('text', 'template')),
  reply_text TEXT CHECK (reply_text IS NULL OR length(reply_text) BETWEEN 1 AND 4096),
  template_name TEXT CHECK (template_name IS NULL OR length(template_name) BETWEEN 1 AND 512),
  template_language TEXT CHECK (template_language IS NULL OR length(template_language) BETWEEN 2 AND 10),
  -- JSON array of {source, value?}; sources: customer_name, handler_name, handler_phone, custom.
  template_params TEXT CHECK (template_params IS NULL OR json_valid(template_params)),
  cooldown_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (cooldown_minutes BETWEEN 1 AND 10080),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((reply_type = 'text' AND reply_text IS NOT NULL) OR (reply_type = 'template' AND template_name IS NOT NULL AND template_language IS NOT NULL))
);
CREATE INDEX whatsapp_auto_replies_position_idx ON whatsapp_auto_replies(position, created_at);

-- One row per customer message a rule answered. The unique pair makes webhook redeliveries harmless, and the
-- (rule, customer) index serves the per-customer cooldown.
CREATE TABLE whatsapp_auto_reply_log (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wal_*'),
  rule_id TEXT NOT NULL REFERENCES whatsapp_auto_replies(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  inbound_external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, inbound_external_id)
);
CREATE INDEX whatsapp_auto_reply_log_cooldown_idx ON whatsapp_auto_reply_log(rule_id, customer_id, created_at DESC);
CREATE INDEX whatsapp_auto_reply_log_recent_idx ON whatsapp_auto_reply_log(created_at DESC);

CREATE TABLE whatsapp_quick_messages (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wqm_*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
