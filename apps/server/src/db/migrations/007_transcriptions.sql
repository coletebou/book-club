-- The server's own speech recogniser (TRANSCRIBE_COMMAND) and each audiobook. `runs` counts the
-- runs begun on it, each counted as it starts (one the server stops as it shuts down is given
-- back), so a recogniser that fails on a file, or brings the server down, is not run again at
-- every start; `last_error` is why the last one failed. `removed_at`: the club owner removed the
-- audiobook's transcript, and the server never makes it one by itself again (the owner can still
-- upload one).
CREATE TABLE transcriptions (
  edition_id TEXT PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  runs       INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  removed_at INTEGER,
  updated_at INTEGER NOT NULL
);
