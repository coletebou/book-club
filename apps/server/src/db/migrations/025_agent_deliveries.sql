-- Deliveries to agents of other services (D205): one row for each message delivered to an agent,
-- kept so that what the agent writes back is fenced by what it was given, not by what the
-- conversation holds when its answer arrives. Judged then, a fenced message deleted meanwhile, or
-- the channel's messages a question that starts a conversation is sent with, would not count, and
-- the answer could carry their words past their fence.
--
-- `fence_t` is the furthest spoiler fence of everything the delivery carried (the message and the
-- conversation before it, as its asker may read them): null when none of it was fenced, and always
-- null in General, which has no fences. An answer to the message is fenced there, at its asker's
-- place (`asker_id`, as D204's `spoiler_user_id`), since every word the agent was given was theirs
-- to read. An agent's message of its own in a book's channel answers no one: it is fenced at the
-- furthest fence ever delivered to that agent in that channel. A message never delivered to an
-- agent is not one it may answer.
--
-- The row is written before the first attempt (an agent may answer before its webhook's reply to
-- Book Club arrives), and kept for as long as its message is. A retry is built again, carrying the
-- conversation as it is then (its asker may have read on), and raises `fence_t` to cover it, never
-- lowers it: an attempt before may have got through.
--
-- Additive only: one new table. A delivery goes with its message, its club, its book or its asker.
CREATE TABLE agent_deliveries (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  book_id    TEXT REFERENCES books(id) ON DELETE CASCADE,
  asker_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fence_t    REAL,
  created_at INTEGER NOT NULL
);
-- A message is delivered to an agent once (its retries reuse the delivery's id).
CREATE UNIQUE INDEX agent_deliveries_message ON agent_deliveries(agent, message_id);
-- The furthest fence an agent was ever given in a channel.
CREATE INDEX agent_deliveries_channel ON agent_deliveries(agent, club_id, book_id);
