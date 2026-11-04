-- Forced alignment (docs/ALIGNMENT.md, D46). What a speech recogniser heard in an audiobook, kept
-- per track file (by blob, so reordering the tracks keeps it right), and the sentences of the
-- text edition it was lined up with, which drive the sentence-level sync map and read-along.
CREATE TABLE transcripts (
  edition_id  TEXT PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  engine      TEXT NOT NULL,
  tracks_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE readalong (
  audio_edition_id   TEXT PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  text_edition_id    TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  -- The edition whose sync map the alignment refined: the audiobook, or the text when the
  -- audiobook defines the book's timeline.
  refined_edition_id TEXT NOT NULL,
  sentences_json     TEXT NOT NULL,
  stats_json         TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX readalong_text ON readalong(text_edition_id);
