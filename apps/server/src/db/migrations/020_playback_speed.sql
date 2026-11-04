-- Listening speed (D195). Additive only: two new tables, nothing existing changes.
--
-- Your default speed, the one a book you have never listened to starts at: one row per person who
-- has ever chosen one (absence means 1.0x, where everyone starts), as chat_dnd does (D173). `at`
-- is the client's clock when it was chosen: a change made offline and sent later loses to a newer
-- one made elsewhere in the meantime.
CREATE TABLE listening_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_rate REAL NOT NULL,
  at           INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The last speed each person listened to each book at, newest choice wins (`at`, as above). Gone
-- with the book when an admin purges it, and with the person.
CREATE TABLE book_playback (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  rate       REAL NOT NULL,
  at         INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
