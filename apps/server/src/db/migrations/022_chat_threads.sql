-- Reply threading in chat (D200). A reply already names the message it answers (`parent_id`,
-- since 015); it now also names the first message of its conversation, the thread's root, however
-- deep the chain of replies runs, so that a whole thread is one indexed query and a root's reply
-- count one GROUP BY, never a walk up `parent_id` at read time.
--
-- Additive only: one nullable column and one index. A root's own `thread_id` stays NULL. Its
-- FOREIGN KEY must default to NULL to be added in place (SQLite's rule for ADD COLUMN with
-- foreign keys on), which it does; the root is soft-deleted like every message, so the only way
-- it goes for good is with its club or book, which take the whole thread with them.
ALTER TABLE chat_messages ADD COLUMN thread_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL;

-- Replies sent before this migration (the API took `parentId` before any UI offered it): each
-- gets the root its chain of parents leads to.
WITH RECURSIVE chain(id, root) AS (
  SELECT id, id FROM chat_messages WHERE parent_id IS NULL
  UNION ALL
  SELECT m.id, chain.root FROM chat_messages m JOIN chain ON m.parent_id = chain.id
)
UPDATE chat_messages SET thread_id = (SELECT root FROM chain WHERE chain.id = chat_messages.id)
 WHERE parent_id IS NOT NULL;

CREATE INDEX chat_messages_thread ON chat_messages(thread_id, created_at) WHERE thread_id IS NOT NULL;
