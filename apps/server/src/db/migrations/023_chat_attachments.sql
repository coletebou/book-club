-- Pictures in chat (D203). Each row is one picture, uploaded before the message that will carry
-- it (POST /api/clubs/:clubId/chat/attachments), so message_id starts NULL and is claimed when the
-- message is sent; one nobody claims is swept up an hour later (services/chat-images.ts), as a
-- note's media is (D140). `idx` orders a message's pictures.
--
-- Only what is safe to keep is kept: the picture re-encoded without any of its metadata (EXIF and
-- the GPS position a phone's camera writes into it) and a thumbnail. The upload as it came is
-- never stored, so no copy of where a photo was taken sits in the data directory or its backups.
--
-- Additive only: a new table. A message's pictures go with it (ON DELETE CASCADE, and at once on
-- delete, routes/chat.ts), and the hourly blob sweep (repos/blobs.ts) counts these rows as uses.
CREATE TABLE chat_attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  club_id       TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL CHECK (kind IN ('image')),
  -- 'processing' while the upload request makes it safe (D142's shape); 'ready' with its blobs;
  -- 'failed' (blobs removed, the row kept only to tell the uploader why).
  status        TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')) DEFAULT 'processing',
  blob_id       TEXT REFERENCES blobs(id),
  thumb_blob_id TEXT REFERENCES blobs(id),
  mime          TEXT,
  width         INTEGER,
  height        INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX chat_attachments_message ON chat_attachments(message_id, idx) WHERE message_id IS NOT NULL;
-- Uploaded but never sent (the composer was closed, the tab was): swept up by age.
CREATE INDEX chat_attachments_orphan ON chat_attachments(created_at) WHERE message_id IS NULL;
