-- Agents in chat (D204, D205): Cal answers in the club's chat when a member @-mentions him, and
-- other agents take part the same way. An agent writes chat messages as a member does, so it has a
-- `users` row to be their author: one per agent, named by its handle (`agent`: 'cal' for Cal).
--
-- That row is no account. It has no email, no password, no upstream subject and no external
-- identity, and `disabled_at` is set, so no sign-in and no session can ever resolve to it
-- (repos/sessions.ts refuses a disabled user). It is never a member of a club, and it is left out
-- wherever accounts are counted (the first-owner setup screen counts users: repos/users.ts
-- countUsers), so a fresh instance with Cal configured still offers its setup.
--
-- Cal's answer is spoiler-fenced at the place of the member he answers (he drew only on what they
-- have read), and it opens for that member as their own words do, however their reading is judged
-- (an audiobook's place is judged with a margin, which would otherwise keep it from them):
-- `chat_messages.spoiler_user_id` names whose place a fence is. Null, as on every message until
-- now: the writer's own.
--
-- Additive only: two nullable columns and one partial unique index. The new foreign key defaults to
-- NULL, which SQLite needs to add it in place (022 did the same).
ALTER TABLE users ADD COLUMN agent TEXT;

CREATE UNIQUE INDEX users_agent ON users(agent) WHERE agent IS NOT NULL;

ALTER TABLE chat_messages ADD COLUMN spoiler_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
