-- Sign-in codes are now bound to a method and an identifier (an email address or a phone number), not only an email.
-- The column keeps its rows (any open code was issued for an email and simply expires).
ALTER TABLE web_login_codes RENAME COLUMN email_key TO identifier_key;
DROP INDEX IF EXISTS web_login_codes_email_idx;
CREATE INDEX web_login_codes_identifier_idx ON web_login_codes(identifier_key, created_at DESC);
