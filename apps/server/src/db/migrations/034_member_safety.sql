CREATE TABLE member_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX member_blocks_blocked ON member_blocks(blocked_id);

CREATE TABLE content_reports (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  book_id TEXT,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'comment', 'reaction')),
  reason TEXT NOT NULL CHECK (reason IN ('harassment', 'spam', 'unsafe', 'other')),
  details TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, kind, target_id)
);
CREATE INDEX content_reports_club ON content_reports(club_id, created_at DESC, id DESC);
CREATE INDEX content_reports_author ON content_reports(author_id);
