-- Stored media for WhatsApp messages. The file lives in the private bucket under media_key; media_id is Meta's id
-- (valid for about 30 days) from which a missing file can still be fetched once.
ALTER TABLE whatsapp_messages ADD COLUMN media_id TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_key TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_mime TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_name TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_size INTEGER;
