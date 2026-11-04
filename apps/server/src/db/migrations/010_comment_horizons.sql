-- Where a comment's writer had read to when they wrote it (D69), when that was past its place by
-- more than the page they had on screen: the edition they had read furthest in, the place there
-- (its locator) and its t. A reply sits at its note's place (D48) and a note may be written while
-- paging back (D62), so a friend far ahead could otherwise put a later chapter into an early
-- place. Its words open for a member who has read its place and this one too, judged as a note
-- made here would be: exactly in this edition, from another format with the margins of D63.
-- Comments written before this have none; a deleted comment's words are gone, and its horizon.
ALTER TABLE comments ADD COLUMN horizon_edition_id TEXT;
ALTER TABLE comments ADD COLUMN horizon_locator_json TEXT;
ALTER TABLE comments ADD COLUMN horizon_t REAL;
