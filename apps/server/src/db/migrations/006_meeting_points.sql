-- Where the club will talk next about a book (D53): a stop on the book's timeline (usually where a
-- chapter ends) and perhaps a day. One per book; any member may set, move or clear it.
CREATE TABLE meeting_points (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  t       REAL NOT NULL CHECK (t > 0 AND t <= 1),
  on_day  TEXT,
  set_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_at  INTEGER NOT NULL
);
