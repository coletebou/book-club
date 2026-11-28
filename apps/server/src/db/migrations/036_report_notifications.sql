-- D264: report alerts belong to club owners and carry no reported text or reporter identity.
ALTER TABLE notifications RENAME TO notifications_old;
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('reply', 'reached', 'mention', 'report')),
  book_id         TEXT REFERENCES books(id) ON DELETE CASCADE,
  comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,
  club_id         TEXT REFERENCES clubs(id) ON DELETE CASCADE,
  chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  actor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  chapter_index   INTEGER,
  count           INTEGER NOT NULL DEFAULT 1
);
INSERT INTO notifications (id, user_id, kind, book_id, comment_id, club_id, chat_message_id, actor_id, created_at, read_at, chapter_index, count)
  SELECT id, user_id, kind, book_id, comment_id, club_id, chat_message_id, actor_id, created_at, read_at, chapter_index, count FROM notifications_old;
DROP TABLE notifications_old;
CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE UNIQUE INDEX notifications_reached ON notifications(user_id, actor_id, book_id, chapter_index) WHERE kind = 'reached' AND read_at IS NULL;
CREATE UNIQUE INDEX notifications_mention ON notifications(user_id, chat_message_id) WHERE kind = 'mention';
