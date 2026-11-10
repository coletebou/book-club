-- Cal answers in the narrator's voice (D223): when a voice turn is about a book whose audiobook
-- has a matched voice, Cal's spoken reply uses it instead of his own, so the step from the
-- narration to the answer is not a change of speaker. One row per book, holding up to three
-- ElevenLabs voices, used in this order:
--
--   narration_voice_id  (a) the very voice the narration was generated with, when the audiobook
--                       is itself ElevenLabs speech: the exact voice, so it wins.
--   clone_voice_id      (c) a clone of a human narrator, only with their consent, recorded in
--                       clone_consent (who agreed, when, how). The CHECK below refuses a clone
--                       without it, so no code path can switch one on silently.
--   designed_voice_id   (b) a voice made by ElevenLabs Voice Design from a written description of
--                       the narrator (design_description), never from their recording.
--
-- settings_json holds the delivery the voice is spoken with (stability, similarity, style, speed,
-- the TTS model), speed matched to the narrator's measured pace. narrator_wpm and narrator_f0_hz
-- are what was measured of the narration (words a minute from its transcript, median pitch).
--
-- Additive only: one new table, which goes with its book.
CREATE TABLE narrator_voices (
  book_id            TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  narrator           TEXT NOT NULL DEFAULT '',
  narration_voice_id TEXT,
  designed_voice_id  TEXT,
  design_description TEXT NOT NULL DEFAULT '',
  clone_voice_id     TEXT,
  clone_consent      TEXT NOT NULL DEFAULT '',
  settings_json      TEXT NOT NULL DEFAULT '{}',
  narrator_wpm       REAL,
  narrator_f0_hz     REAL,
  updated_at         INTEGER NOT NULL,
  CHECK (clone_voice_id IS NULL OR length(trim(clone_consent)) > 0)
);
