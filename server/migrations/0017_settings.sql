-- Dashboard-managed configuration (WhatsApp, push, daily email, feature switches). Additive only.
-- Secret values are stored AES-GCM encrypted (encrypted = 1); the key name is bound into the ciphertext.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Existing installs keep working: switch a feature on when it already holds data.
INSERT INTO app_settings (key, value, encrypted, updated_at)
SELECT 'feature.whatsapp', 'true', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM whatsapp_messages)
  OR EXISTS (SELECT 1 FROM whatsapp_auto_replies)
  OR EXISTS (SELECT 1 FROM whatsapp_quick_messages);

INSERT INTO app_settings (key, value, encrypted, updated_at)
SELECT 'feature.customers', 'true', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM customers)
  OR EXISTS (SELECT 1 FROM app_settings WHERE key = 'feature.whatsapp');
