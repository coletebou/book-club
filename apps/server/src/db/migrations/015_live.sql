-- Live chat and @mentions (D150-D152). Voice channels and listening parties (D153-D158) need no
-- tables of their own: both are ephemeral, in-memory state kept by the server process while it
-- runs (apps/server/src/realtime/party.ts, realtime/voice.ts), broadcast the same way presence
-- already is. A party or a voice room has no meaning after the server restarts (nobody expects
-- "resume the listening party" across a deploy, and LiveKit itself is the source of truth for who
-- is actually connected to voice): adding a table and a migration for state nobody needs to
-- survive a restart would be a persistence layer with no invariant to show for it.

CREATE TABLE chat_messages (
  id                 TEXT PRIMARY KEY,
  club_id            TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  -- Null: general club chat. Set: tagged to one of the club's books (so a "spoiler up to <chapter>"
  -- fence has a timeline to be gated against, services/gating.ts Gate, reused as-is for D150).
  book_id            TEXT REFERENCES books(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id          TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  text               TEXT NOT NULL,
  -- The spoiler fence (D150): hidden from a member until their reading of book_id reaches this
  -- place on the shared timeline. Both null together, or both set.
  spoiler_t          REAL,
  spoiler_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  client_id          TEXT,
  created_at         INTEGER NOT NULL,
  edited_at          INTEGER,
  deleted_at         INTEGER
);
CREATE INDEX chat_messages_club ON chat_messages(club_id, created_at);
CREATE INDEX chat_messages_book ON chat_messages(book_id, created_at) WHERE book_id IS NOT NULL;
CREATE INDEX chat_messages_parent ON chat_messages(parent_id) WHERE parent_id IS NOT NULL;
-- A retried post (lost connection, tapped send twice) lands once: the client id stays taken even
-- if the message is later deleted, as comments already do (001_init.sql's comments_client).
CREATE UNIQUE INDEX chat_messages_client ON chat_messages(user_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- One read cursor per member per club (D151): the whole club's chat is one stream (general plus
-- any book-tagged messages, in one timeline of posts), so one unread count and one badge suit it;
-- splitting it per book would ask friends to check N badges for the same conversation.
CREATE TABLE chat_reads (
  club_id              TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at         INTEGER NOT NULL,
  last_read_message_id TEXT,
  PRIMARY KEY (club_id, user_id)
);

-- Notifications grow a third kind, `mention` (D152): someone @-mentioned you in chat. Its subject
-- is a chat message in a club, not a comment in a book, so comment_id/book_id must become
-- optional and two columns (club_id, chat_message_id) are added. SQLite cannot alter a CHECK
-- constraint or a column's nullability in place, so the table is rebuilt (the documented 12-step
-- pattern: new table, copy rows, drop the old one, rebuild its indexes). It runs after 013, so the
-- rebuilt table keeps 013's batching of "reached" notifications (D145): its two columns, their
-- values, and its index, not the one 013 replaced.
ALTER TABLE notifications RENAME TO notifications_old;
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('reply', 'reached', 'mention')),
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
INSERT INTO notifications (id, user_id, kind, book_id, comment_id, actor_id, created_at, read_at, chapter_index, count)
  SELECT id, user_id, kind, book_id, comment_id, actor_id, created_at, read_at, chapter_index, count FROM notifications_old;
DROP TABLE notifications_old;
CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE UNIQUE INDEX notifications_reached ON notifications(user_id, actor_id, book_id, chapter_index) WHERE kind = 'reached' AND read_at IS NULL;
-- A mention notifies once per message per mentioned person, however many times their name appears in it.
CREATE UNIQUE INDEX notifications_mention ON notifications(user_id, chat_message_id) WHERE kind = 'mention';
