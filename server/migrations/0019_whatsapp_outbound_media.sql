-- Files staged for outbound WhatsApp messages (chat attachments and default template header images).
-- The bytes live in the private bucket under object_key. Meta's media id for the file is cached for reuse
-- (Meta keeps it for 30 days); it is only valid for the phone number it was uploaded through.
CREATE TABLE whatsapp_attachments (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wat_*'),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('admin', 'device')),
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  meta_media_id TEXT,
  meta_phone_number_id TEXT,
  meta_uploaded_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX whatsapp_attachments_owner_idx ON whatsapp_attachments(owner_type, owner_id, created_at);
-- Lets the cleanup job tell which staged files a message still shows.
CREATE INDEX whatsapp_messages_media_key_idx ON whatsapp_messages(media_key) WHERE media_key IS NOT NULL;
CREATE INDEX whatsapp_attachments_created_idx ON whatsapp_attachments(created_at);
