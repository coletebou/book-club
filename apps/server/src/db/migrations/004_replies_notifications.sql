-- Replies (D48): a note can be answered. A reply sits at its note's place (it copies the note's
-- position), so it is read exactly when the note is.
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id);
CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;

-- Notifications (D49): a friend answered your note (or a thread you are in), or got to it.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reply', 'reached')),
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  actor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);
-- A friend reaches a note once: reading it again tells nobody anything.
CREATE UNIQUE INDEX notifications_reached ON notifications(user_id, comment_id, actor_id) WHERE kind = 'reached';
