-- One push (FCM) registration token per enrolled phone. A revoked device never receives pushes: the sender joins devices.
CREATE TABLE device_push_tokens (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 20 AND 4096),
  updated_at TEXT NOT NULL
);
CREATE INDEX device_push_tokens_token_idx ON device_push_tokens(token);
