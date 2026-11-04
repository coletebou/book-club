-- Media notes (D140): a note or reply may carry one voice recording, 1-4 photos, or a short
-- video, with or without text. Uploaded before the note that will carry it (POST
-- /api/books/:bookId/media), so comment_id starts null and is claimed when the note is posted;
-- an upload nobody claims is swept up later (services/note-media.ts, an hour old). Each row is one
-- file: `idx` orders photos. Deleting a note deletes its media's rows and blobs (repos/comments.ts).
CREATE TABLE comment_media (
  id                TEXT PRIMARY KEY,
  comment_id        TEXT REFERENCES comments(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id           TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx               INTEGER NOT NULL DEFAULT 0,
  kind              TEXT NOT NULL CHECK (kind IN ('voice', 'photo', 'video')),
  -- 'processing': being made web-safe (brief, held inside the upload request, D142); 'ready' once
  -- it has a derived blob; 'failed' when the file could not be made web-safe (its own blobs, if
  -- any, are removed, and the row kept only so the uploader is told why).
  status            TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')) DEFAULT 'processing',
  original_blob_id  TEXT REFERENCES blobs(id),
  derived_blob_id   TEXT REFERENCES blobs(id),
  poster_blob_id    TEXT REFERENCES blobs(id),
  mime              TEXT,
  duration_ms       INTEGER,
  width             INTEGER,
  height            INTEGER,
  transcript        TEXT,
  transcript_status TEXT NOT NULL CHECK (transcript_status IN ('none', 'queued', 'ready', 'failed')) DEFAULT 'none',
  error             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX comment_media_comment ON comment_media(comment_id);
-- Uploaded but never attached (the composer was closed, the tab was closed): swept up by age.
CREATE INDEX comment_media_orphan ON comment_media(user_id, created_at) WHERE comment_id IS NULL;

-- Batched "reached" notifications (D145): one row per (friend, actor, book, chapter) while unread,
-- so catching up a whole chapter's worth of a friend's notes says so once, not once per note.
-- `count` is how many were folded into it; `chapter_index` is null for a 'reply' notification
-- (unaffected: still one per reply) and for a 'reached' row made before this migration.
ALTER TABLE notifications ADD COLUMN chapter_index INTEGER;
ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
DROP INDEX notifications_reached;
-- While unread, one row per friend, actor, book and chapter; marking it read frees that key, so a
-- fresh note reached there later is its own, new notification rather than reopening the old one.
CREATE UNIQUE INDEX notifications_reached ON notifications(user_id, actor_id, book_id, chapter_index) WHERE kind = 'reached' AND read_at IS NULL;
