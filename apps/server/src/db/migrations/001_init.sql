-- Book Club v2 schema. Times are milliseconds since the Unix epoch.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  email            TEXT UNIQUE COLLATE NOCASE,
  password_hash    TEXT,
  upstream_subject TEXT UNIQUE,
  created_at       INTEGER NOT NULL,
  disabled_at      INTEGER
);

CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE clubs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
  club_id   TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invites_club ON invites(club_id);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE blobs (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE books (
  id                   TEXT PRIMARY KEY,
  club_id              TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  author               TEXT NOT NULL DEFAULT '',
  cover_blob_id        TEXT REFERENCES blobs(id),
  reference_edition_id TEXT,
  chapters_json        TEXT NOT NULL DEFAULT '[]',
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           INTEGER NOT NULL
);
CREATE INDEX books_club ON books(club_id);

CREATE TABLE editions (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('epub', 'pdf', 'audio')),
  status         TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  error          TEXT,
  geometry_json  TEXT,
  units_json     TEXT NOT NULL DEFAULT '[]',
  sync_json      TEXT,
  alignment_json TEXT NOT NULL DEFAULT '{"method":"none","unitToChapter":[]}',
  meta_json      TEXT NOT NULL DEFAULT '{}',
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL
);
CREATE INDEX editions_book ON editions(book_id);

CREATE TABLE edition_files (
  edition_id    TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  blob_id       TEXT NOT NULL REFERENCES blobs(id),
  role          TEXT NOT NULL CHECK (role IN ('main', 'track')),
  title         TEXT NOT NULL DEFAULT '',
  duration_ms   REAL,
  original_name TEXT NOT NULL,
  PRIMARY KEY (edition_id, idx)
);

CREATE TABLE imports (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('epub', 'pdf', 'audio')),
  status     TEXT NOT NULL CHECK (status IN ('uploading', 'finalized', 'cancelled')),
  files_json TEXT NOT NULL,
  book_id    TEXT,
  edition_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX imports_user ON imports(user_id);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  import_id    TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  file_index   INTEGER NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size         INTEGER NOT NULL,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX uploads_import ON uploads(import_id, file_index);

CREATE TABLE progress (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id       TEXT,
  locator_json     TEXT,
  t                REAL NOT NULL DEFAULT 0,
  label            TEXT NOT NULL DEFAULT '',
  client_at        INTEGER NOT NULL DEFAULT 0,
  read_ranges_json TEXT NOT NULL DEFAULT '[]',
  furthest         REAL NOT NULL DEFAULT 0,
  coverage         REAL NOT NULL DEFAULT 0,
  finished_at      INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX progress_book ON progress(book_id);

CREATE TABLE comments (
  id               TEXT PRIMARY KEY,
  book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('epub', 'pdf', 'audio')),
  locator_json     TEXT NOT NULL,
  end_locator_json TEXT,
  t                REAL NOT NULL,
  end_t            REAL,
  quote            TEXT,
  text             TEXT,
  reaction         TEXT,
  client_id        TEXT,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  CHECK (text IS NOT NULL OR reaction IS NOT NULL)
);
CREATE INDEX comments_book ON comments(book_id, t);
CREATE UNIQUE INDEX comments_client ON comments(user_id, client_id) WHERE client_id IS NOT NULL;
