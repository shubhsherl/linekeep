-- Per-viewer read markers for WhatsApp chats. Administrators and employees read the same chats independently:
-- opening a chat as one viewer never marks it read for another.

CREATE TABLE whatsapp_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- History imported before this feature is not "unread": only customer messages newer than this count.
INSERT INTO whatsapp_settings (key, value) VALUES ('unread_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE whatsapp_chat_reads (
  viewer_type TEXT NOT NULL CHECK (viewer_type IN ('admin', 'employee')),
  -- An administrator's Access e-mail address (or 'local' for the development bypass), or an employee id.
  viewer_id TEXT NOT NULL CHECK (length(viewer_id) BETWEEN 1 AND 256),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  -- sent_at of the newest customer message this viewer has seen in the chat.
  last_read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (viewer_type, viewer_id, customer_id)
) WITHOUT ROWID;

-- Serves the all-chats unread total without touching outgoing messages or old history.
CREATE INDEX whatsapp_messages_inbound_idx ON whatsapp_messages(sent_at) WHERE direction = 'in';
