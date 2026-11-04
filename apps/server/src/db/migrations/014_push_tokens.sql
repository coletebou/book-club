-- Device push tokens for the iOS app's native notifications (D134): no Expo account exists, so
-- each phone registers its raw APNs device token (expo-notifications' getDevicePushTokenAsync,
-- not Expo's push service). One row per device; a token moves to whoever last registered it (the
-- same phone, signed in as someone else) rather than letting two users fight over one device.
-- Removed on request (signing out of the app) or when APNs itself says the token no longer works
-- (a 410 Unregistered reply; services/push.ts).
CREATE TABLE push_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL DEFAULT 'ios',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX push_tokens_user ON push_tokens (user_id);
