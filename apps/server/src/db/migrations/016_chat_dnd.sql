-- Do Not Disturb for chat/mentions (D173): one row per person who has ever touched the switch
-- (absence means off, the default everyone starts at), not a column on `users` — this is a
-- single-purpose, optional preference next to a table of dozens of unrelated columns, and a
-- separate table costs nothing extra to query (one indexed lookup by primary key).
CREATE TABLE chat_dnd (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
