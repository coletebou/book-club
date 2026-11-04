-- One-time codes to sign in where you are not yet (D87): the app on a phone's Home Screen, whose
-- cookies are not the browser's, or another device. Made by someone signed in, typed there. Kept
-- as a hash; only a person's newest code works, once, for ten minutes.
CREATE TABLE sign_in_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX sign_in_codes_user ON sign_in_codes (user_id);
