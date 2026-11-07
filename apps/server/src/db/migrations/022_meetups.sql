-- Meet-ups (D206): the next stop (D53, migration 006) becomes the club's meeting. It may have a time
-- (an instant, with the time zone it was set in, for showing it the way its setter meant it), how
-- long it runs, and where it is: the club's own voice room, a place, or a link to a video call.
ALTER TABLE meeting_points ADD COLUMN starts_at INTEGER;
ALTER TABLE meeting_points ADD COLUMN tz TEXT;
ALTER TABLE meeting_points ADD COLUMN minutes INTEGER;
ALTER TABLE meeting_points ADD COLUMN place_kind TEXT CHECK (place_kind IN ('voice', 'place', 'link'));
ALTER TABLE meeting_points ADD COLUMN place TEXT;

-- Who is coming (D206). An answer is for one occasion, the meeting's day or time when it was given:
-- moving the meeting to another evening leaves the old answers behind (they no longer count) rather
-- than deleting them, so moving it back brings them back. Clearing the meeting clears its answers.
CREATE TABLE meeting_rsvps (
  book_id     TEXT NOT NULL REFERENCES meeting_points(book_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
  occasion    TEXT NOT NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, user_id)
);

-- A private calendar feed per person (D207): every meet-up of every club they are in, for their
-- calendar app to subscribe to. Only the token's hash is kept, like a session's.
CREATE TABLE calendar_feeds (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
