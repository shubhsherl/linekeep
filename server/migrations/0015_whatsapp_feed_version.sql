-- A counter that moves whenever anything in the WhatsApp feed changes, so clients can learn "something changed" with one
-- tiny row read instead of re-reading chat lists. Triggers cover every writer: webhook, sends, delivery receipts, media.
INSERT INTO whatsapp_settings (key, value) VALUES ('feed_version', '1');

CREATE TRIGGER whatsapp_feed_version_insert AFTER INSERT ON whatsapp_messages
BEGIN
  UPDATE whatsapp_settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'feed_version';
END;

CREATE TRIGGER whatsapp_feed_version_update AFTER UPDATE OF status, delivered_at, read_at, body, media_key, external_id ON whatsapp_messages
BEGIN
  UPDATE whatsapp_settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'feed_version';
END;
