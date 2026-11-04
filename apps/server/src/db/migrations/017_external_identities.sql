-- Native "Sign in with Apple" and "Continue with Google" (D178): who an external identity belongs
-- to, keyed by (provider, subject) rather than reusing the single-column `upstream_subject` D116
-- already owns for the upstream grant, because one person may end up linking more than one of
-- these (Apple now, Google later, perhaps an upstream account too) to the same account, which a lone
-- column cannot represent. `email` is kept only for the record (never queried to decide anything:
-- the linking rule reads `users.email`, D178), and only when the provider itself vouched for it.
CREATE TABLE external_identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX external_identities_user ON external_identities (user_id);

-- A native Google sign-in's one-time handoff from the browser session back into the app's WebView
-- (D178): minted once the browser side has a real signed-in person, bound to the PKCE challenge
-- the app generated before it ever opened that browser session, so a code intercepted on the way
-- back (the `bookclub://auth` redirect, a URL) is useless without the matching verifier, which
-- never leaves the app. Shaped like `sign_in_codes` above, but keyed by a long random token (handed
-- over in a URL, not typed by a person) and carrying the challenge it is bound to.
CREATE TABLE app_auth_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX app_auth_codes_user ON app_auth_codes (user_id);
