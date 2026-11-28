-- D276: widen the kind check to allow audio while copying all existing picture rows unchanged.
CREATE TABLE chat_attachments_next (
  id             TEXT PRIMARY KEY,
  message_id     TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  club_id        TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL CHECK (kind IN ('image', 'voice')),
  status         TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')) DEFAULT 'processing',
  blob_id        TEXT REFERENCES blobs(id),
  thumb_blob_id  TEXT REFERENCES blobs(id),
  mime           TEXT,
  width          INTEGER,
  height         INTEGER,
  duration_ms    INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
INSERT INTO chat_attachments_next (id, message_id, club_id, user_id, idx, kind, status, blob_id, thumb_blob_id, mime, width, height, error, created_at)
SELECT id, message_id, club_id, user_id, idx, kind, status, blob_id, thumb_blob_id, mime, width, height, error, created_at FROM chat_attachments;
DROP TABLE chat_attachments;
ALTER TABLE chat_attachments_next RENAME TO chat_attachments;
CREATE INDEX chat_attachments_message ON chat_attachments(message_id, idx) WHERE message_id IS NOT NULL;
CREATE INDEX chat_attachments_orphan ON chat_attachments(created_at) WHERE message_id IS NULL;
