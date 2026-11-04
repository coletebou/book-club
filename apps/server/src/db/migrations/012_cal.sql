-- Cal (Callimachus): the club's native AI assistant. D160-D169 (docs/DECISIONS.md).
-- Times are milliseconds since the Unix epoch, as everywhere else in this schema.

-- A series groups a club's books in reading order, for Cal's spoiler gate: a book later in a
-- series the asker has not started is left out of search entirely (D162), not merely filtered by
-- position. An owner may also set this by hand when a book's own metadata does not say.
CREATE TABLE series (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX series_club ON series(club_id);

ALTER TABLE books ADD COLUMN series_id TEXT REFERENCES series(id);
ALTER TABLE books ADD COLUMN series_order REAL;
CREATE INDEX books_series ON books(series_id, series_order);

-- Per-user Cal preferences. "Cal may use the whole series" (D162) lifts the default spoiler gate
-- for every question until turned off again; a question can still lift it just for itself
-- (cal_messages.content_json carries that per-question choice, never stored here).
CREATE TABLE cal_settings (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  whole_series        INTEGER NOT NULL DEFAULT 0,
  voice_provider      TEXT,
  updated_at          INTEGER NOT NULL
);

-- A conversation with Cal: private to its owner by default (D166); "share to club chat" (not yet
-- built, tracked in docs/TRACEABILITY.md) would post a message, not change this row's visibility.
CREATE TABLE cal_conversations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id        TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  book_id        TEXT REFERENCES books(id) ON DELETE SET NULL,
  title          TEXT NOT NULL DEFAULT '',
  shared_to_club INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX cal_conversations_user ON cal_conversations(user_id, updated_at DESC);

CREATE TABLE cal_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES cal_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- A JSON array of content parts: {type:'text', text}, {type:'citation', ...}, {type:'tool', ...}.
  content_json    TEXT NOT NULL,
  whole_series    INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX cal_messages_conversation ON cal_messages(conversation_id, created_at);

-- Material a member feeds Cal beyond the club's books ("Cal's shelf", D163): an upload or a
-- fetched URL, readable-text extracted server-side, indexed exactly like a book's text but
-- without a timeline position (shelf chunks carry no t and are never spoiler-gated).
CREATE TABLE cal_shelf_items (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('pdf', 'epub', 'txt', 'md', 'url')),
  title      TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  blob_id    TEXT REFERENCES blobs(id),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')) DEFAULT 'pending',
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX cal_shelf_items_club ON cal_shelf_items(club_id);

-- A chunk of indexed text: a book's edition (with its place on the timeline) or a shelf item
-- (no timeline place: general material is never spoiler-gated, D163). `seq` is this source's
-- chunk order, used to fetch a passage's neighbours (get_passage).
CREATE TABLE cal_chunks (
  id             TEXT PRIMARY KEY,
  club_id        TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  source_type    TEXT NOT NULL CHECK (source_type IN ('book', 'shelf')),
  book_id        TEXT REFERENCES books(id) ON DELETE CASCADE,
  edition_id     TEXT REFERENCES editions(id) ON DELETE CASCADE,
  shelf_item_id  TEXT REFERENCES cal_shelf_items(id) ON DELETE CASCADE,
  chapter_title  TEXT,
  t_start        REAL,
  t_end          REAL,
  seq            INTEGER NOT NULL,
  text           TEXT NOT NULL,
  token_count    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  CHECK (
    (source_type = 'book' AND book_id IS NOT NULL AND edition_id IS NOT NULL AND shelf_item_id IS NULL) OR
    (source_type = 'shelf' AND shelf_item_id IS NOT NULL AND book_id IS NULL AND edition_id IS NULL)
  )
);
CREATE INDEX cal_chunks_edition ON cal_chunks(edition_id, seq);
CREATE INDEX cal_chunks_shelf ON cal_chunks(shelf_item_id, seq);
CREATE INDEX cal_chunks_book_t ON cal_chunks(book_id, t_start);
CREATE INDEX cal_chunks_club ON cal_chunks(club_id);

-- Full-text (BM25) half of hybrid search: an external-content FTS5 table over cal_chunks.text,
-- kept in sync by triggers so a chunk is never searchable after it (or its edition) is gone.
CREATE VIRTUAL TABLE cal_chunks_fts USING fts5(text, content='cal_chunks', content_rowid='rowid');

CREATE TRIGGER cal_chunks_ai AFTER INSERT ON cal_chunks BEGIN
  INSERT INTO cal_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER cal_chunks_ad AFTER DELETE ON cal_chunks BEGIN
  INSERT INTO cal_chunks_fts(cal_chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER cal_chunks_au AFTER UPDATE ON cal_chunks BEGIN
  INSERT INTO cal_chunks_fts(cal_chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO cal_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Vector half: one embedding per chunk, float32 BLOB (brute-force cosine in a worker thread,
-- docs/DECISIONS.md D161 — measured; sqlite-vec only if a future measurement demands it).
CREATE TABLE cal_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES cal_chunks(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Resumable indexing (mirrors the ingest pipeline's own "processing" re-queue on boot, D164): one
-- row per book edition or shelf item ever queued for indexing.
CREATE TABLE cal_index_status (
  kind       TEXT NOT NULL CHECK (kind IN ('edition', 'shelf_item')),
  ref_id     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error      TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);

-- What Cal's embedding and chat calls cost, logged for the per-club monthly spend cap (D168).
CREATE TABLE cal_cost_log (
  id         TEXT PRIMARY KEY,
  club_id    TEXT REFERENCES clubs(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('embed', 'chat', 'voice_stt', 'voice_tts')),
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  input_units  INTEGER NOT NULL DEFAULT 0,
  output_units INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX cal_cost_log_club_month ON cal_cost_log(club_id, created_at);
