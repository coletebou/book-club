-- The audiobook's controls in the book (D197). Additive only: two new tables, nothing existing changes.
--
-- Your default: shown unless you hide them (absence means shown, where everyone starts). `at` is
-- the client's clock when it was chosen, as the listening speed's (D195): a change made offline
-- and sent later loses to a newer one made elsewhere in the meantime.
CREATE TABLE audio_controls_default (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hidden     INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  at         INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One book's own choice over that default: hidden (1), shown (0), or NULL, as the default says
-- (a choice too, with its time, so that it can win over an older one from another device).
CREATE TABLE book_audio_controls (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  hidden     INTEGER CHECK (hidden IN (0, 1)),
  at         INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
