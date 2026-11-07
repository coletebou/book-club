-- Picking the next book (D214): nominate, approval-vote, one open round at a time, Up next.
--
-- A club has at most one open round; enforced here, not just in the route, by a partial unique
-- index on (club_id) where status = 'open' (the same trick as 015's notifications_mention: a
-- constraint rather than a race between two members opening one at the same moment).
CREATE TABLE nomination_rounds (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at  INTEGER NOT NULL,
  closed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_at  INTEGER
);
CREATE INDEX nomination_rounds_club ON nomination_rounds(club_id, opened_at);
CREATE UNIQUE INDEX nomination_rounds_one_open ON nomination_rounds(club_id) WHERE status = 'open';

-- A nomination: title (required), author, an optional external link (Goodreads, StoryGraph, Open
-- Library, …, stored and shown as-is, never fetched by the server) and a short pitch. Withdrawing
-- (the nominator) or removing (the club owner) deletes the row outright, taking its votes with it
-- (ON DELETE CASCADE below): a round's nominations are only ever the ones still standing.
CREATE TABLE nominations (
  id         TEXT PRIMARY KEY,
  round_id   TEXT NOT NULL REFERENCES nomination_rounds(id) ON DELETE CASCADE,
  -- Denormalised from round_id for a direct index on a club's nominations (access checks, history).
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  author     TEXT,
  link       TEXT,
  pitch      TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX nominations_round ON nominations(round_id);
CREATE INDEX nominations_club ON nominations(club_id, created_at);

-- Approval voting (D214): each member may vote for any number of nominations, changing their
-- votes until the round closes. One row per member per nomination they currently back.
CREATE TABLE nomination_votes (
  nomination_id TEXT NOT NULL REFERENCES nominations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (nomination_id, user_id)
);
CREATE INDEX nomination_votes_user ON nomination_votes(user_id);

-- The round's winner, added once nominations exists (SQLite cannot forward-reference a table that
-- is not there yet): the nomination with the most votes when the round closed, or the one the
-- closer chose among a tie (D214). Null for a round closed with nothing nominated.
ALTER TABLE nomination_rounds ADD COLUMN winner_nomination_id TEXT REFERENCES nominations(id) ON DELETE SET NULL;

-- A club's up next (D214): one row while it has one, the winner of its last closed round, until
-- the owner or whoever adds it marks it done, or it is cleared automatically because a book whose
-- title matches was just added (services/next-book.ts).
CREATE TABLE club_up_next (
  club_id       TEXT PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  nomination_id TEXT NOT NULL REFERENCES nominations(id) ON DELETE CASCADE,
  round_id      TEXT NOT NULL REFERENCES nomination_rounds(id) ON DELETE CASCADE,
  set_at        INTEGER NOT NULL
);
