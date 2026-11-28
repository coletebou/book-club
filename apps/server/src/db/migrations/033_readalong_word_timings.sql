-- Word timings (D244) are read only when someone opens the words view. Keep one row per track
-- so a request does not parse or return the other tracks' timings.
CREATE TABLE readalong_word_timings (
  audio_edition_id TEXT NOT NULL REFERENCES readalong(audio_edition_id) ON DELETE CASCADE,
  track INTEGER NOT NULL CHECK (track >= 0),
  timings_json TEXT NOT NULL,
  PRIMARY KEY (audio_edition_id, track)
) STRICT;
