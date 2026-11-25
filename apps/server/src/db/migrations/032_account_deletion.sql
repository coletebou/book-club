-- A person deletes their own account from Settings (D229). The `users` row is not removed: foreign
-- keys that do not cascade (the clubs, books and invites the person made) and the notes and
-- messages that stay in their clubs, shown as a "Former member", all name it. What makes it theirs
-- is emptied (name, address, password, identities, sessions, tokens, settings, progress), and the
-- row says when that happened. A deleted row is always a disabled one, so the check every sign-in
-- path already makes (`disabled_at`) covers it, whatever wrote it.
ALTER TABLE users ADD COLUMN deleted_at INTEGER
  CHECK (deleted_at IS NULL OR disabled_at IS NOT NULL);

-- The merge record (migration 031) holds, whole, the rows a merge dropped (an address, a sign-in
-- identity, a reading position). When either account of a merge is deleted, that record is erased
-- too: the one change the append-only trigger now lets through is replacing the archive and the
-- operator's reason with these two fixed words. Who went into whom, and when, stays.
DROP TRIGGER account_merges_no_update;
CREATE TRIGGER account_merges_no_update BEFORE UPDATE ON account_merges
WHEN NOT (
  NEW.id IS OLD.id AND NEW.loser_id IS OLD.loser_id AND NEW.survivor_id IS OLD.survivor_id
  AND NEW.merged_at IS OLD.merged_at AND NEW.counts_json IS OLD.counts_json
  AND ((NEW.archive_json IS OLD.archive_json AND NEW.reason IS OLD.reason)
    OR (NEW.archive_json = '{"erased":true}' AND NEW.reason = 'erased'))
)
BEGIN
  SELECT RAISE(ABORT, 'account_merges is append-only');
END;
