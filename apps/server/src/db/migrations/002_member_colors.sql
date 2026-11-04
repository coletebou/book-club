-- Each member's colour in a club is a palette slot taken when they join, so the friends in a
-- club of up to eight never share one. (Colours used to come from a hash of the user id; with
-- eight colours, four friends shared one more often than not.) Existing members get slots in
-- the order they joined. 8 is the length of MEMBER_PALETTE in packages/shared.
ALTER TABLE memberships ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
UPDATE memberships SET color = (
  SELECT COUNT(*) FROM memberships earlier
   WHERE earlier.club_id = memberships.club_id
     AND (earlier.joined_at < memberships.joined_at
          OR (earlier.joined_at = memberships.joined_at AND earlier.user_id < memberships.user_id))
) % 8;
