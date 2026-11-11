-- One person, one account (D228): `bookclub merge-accounts` folds a second account a person ended
-- up with into the one they keep. The merge is soft. The account merged away stays as a row that
-- signs nobody in (`disabled_at`) and says where it went (`merged_into`), so a sign-in that still
-- finds it (an identity, an address) is led on to the account that took its place.
--
-- A merged row is always a disabled one, and never points at itself: the two checks every sign-in
-- path already makes (`disabled_at`) therefore cover a merged row too, whatever wrote it.
ALTER TABLE users ADD COLUMN merged_into TEXT REFERENCES users(id)
  CHECK (merged_into IS NULL OR (disabled_at IS NOT NULL AND merged_into <> id));

CREATE INDEX users_merged_into ON users(merged_into) WHERE merged_into IS NOT NULL;

-- What each merge did, kept for good: who went into whom, when, why (the operator's own words),
-- how many rows of each table moved or were dropped (`counts_json`), and every row the merge
-- dropped instead of moving, and every value it overwrote, whole (`archive_json`), so a merge can
-- be put back by hand. The ids are plain text, not foreign keys: the record stands on its own.
CREATE TABLE account_merges (
  id           TEXT PRIMARY KEY,
  loser_id     TEXT NOT NULL,
  survivor_id  TEXT NOT NULL,
  merged_at    INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  counts_json  TEXT NOT NULL,
  archive_json TEXT NOT NULL
);
CREATE INDEX account_merges_loser ON account_merges(loser_id);
CREATE INDEX account_merges_survivor ON account_merges(survivor_id);

-- Append-only: a merge is recorded once and never rewritten or removed by the app.
CREATE TRIGGER account_merges_no_update BEFORE UPDATE ON account_merges
BEGIN
  SELECT RAISE(ABORT, 'account_merges is append-only');
END;
CREATE TRIGGER account_merges_no_delete BEFORE DELETE ON account_merges
BEGIN
  SELECT RAISE(ABORT, 'account_merges is append-only');
END;
