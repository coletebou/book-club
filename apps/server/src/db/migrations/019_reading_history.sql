-- Your own reading and listening history (D191): each stretch of reading or listening, one row per
-- sitting, on one device, in one edition. Kept apart from `progress` (where you are, what you have
-- read): this says when, for how long and on what, and only ever to the person it is about.
-- Positions are in the edition's own measure (characters, pages or milliseconds, as
-- `edition_progress`) with the locators they came from, and on the book's timeline when recorded.
CREATE TABLE reading_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id  TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('epub', 'pdf', 'audio')),
  device      TEXT NOT NULL,
  -- On the device's clock (ms since the epoch), as reports say.
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  active_ms   INTEGER NOT NULL DEFAULT 0,
  from_m      REAL NOT NULL,
  to_m        REAL NOT NULL,
  -- Where the last stretch ended: the next one continues this sitting only from near here.
  last_m      REAL NOT NULL,
  from_json   TEXT NOT NULL,
  to_json     TEXT NOT NULL,
  from_t      REAL NOT NULL,
  to_t        REAL NOT NULL,
  from_page   INTEGER,
  to_page     INTEGER,
  -- When it was read or heard: sorted, disjoint [from, to] intervals of the device's clock, so the
  -- time spent adds up the same whatever order the reports arrive in.
  times_json  TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX reading_sessions_user ON reading_sessions (user_id, ended_at DESC);
CREATE INDEX reading_sessions_sitting ON reading_sessions (user_id, book_id, edition_id, device, ended_at);
