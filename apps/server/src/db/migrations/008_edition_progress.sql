-- What each member has read in each edition of a book, beside the book-wide ranges in `progress`.
-- Ranges are in the edition's own measure (its characters, pages or milliseconds), so they mean
-- the same whatever its sync map becomes. A note opens exactly where its own edition was read
-- past it; reading in another format, lined up with it only by chapters, opens it once past it
-- by a margin covering the error of the maps between them.
CREATE TABLE edition_progress (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id       TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  read_ranges_json TEXT NOT NULL DEFAULT '[]',
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id, edition_id)
);

-- What was read before this, on the book's timeline, in a format nobody knows any more: it counts
-- as reading in another format than any note's, for good.
ALTER TABLE progress ADD COLUMN unplaced_ranges_json TEXT NOT NULL DEFAULT '[]';
UPDATE progress SET unplaced_ranges_json = read_ranges_json;
