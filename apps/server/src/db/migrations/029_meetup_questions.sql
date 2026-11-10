-- What to talk about at the meet-up (D209): questions for a stop, from a friend or from Cal. A
-- question is placed at its stop and, from a friend, carries where they had read to when they
-- wrote it (D69's horizon, as a note does), so its words reach only friends the gate opens it to.
-- Cal's carry no horizon: he wrote them from the text up to the stop alone. Removed questions are
-- kept marked, as notes are, and their words cleared.
CREATE TABLE meetup_questions (
  id                   TEXT PRIMARY KEY,
  book_id              TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  t                    REAL NOT NULL CHECK (t > 0 AND t <= 1),
  text                 TEXT NOT NULL,
  -- The friend who wrote it; null for Cal's, with `asked_by` the friend who asked him.
  author_id            TEXT REFERENCES users(id) ON DELETE CASCADE,
  asked_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  horizon_edition_id   TEXT,
  horizon_locator_json TEXT,
  horizon_t            REAL,
  created_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX meetup_questions_book ON meetup_questions(book_id, t);

CREATE TABLE meetup_question_votes (
  question_id TEXT NOT NULL REFERENCES meetup_questions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (question_id, user_id)
);

-- Each time a friend asked Cal for questions for a stop, whatever he came back with: his asks are
-- rationed per stop per day (D209), and an ask that brought nothing new still counts.
CREATE TABLE meetup_question_asks (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  t        REAL NOT NULL,
  user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  asked_at INTEGER NOT NULL
);
CREATE INDEX meetup_question_asks_book ON meetup_question_asks(book_id, asked_at);
