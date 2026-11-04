-- Sessions that were ended (signing out, everywhere, a new password), remembered for as long as
-- their cookie could still be presented. A request already on its way with one when the session
-- ended must not be signed in again from an upstream cookie (D52).
CREATE TABLE ended_sessions (
  id_hash    TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
