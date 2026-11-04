-- Disbanding a club and removing a book are soft deletes (D179): the row is marked, the app treats
-- it as gone (repos/clubs.ts clubById, repos/books.ts bookById), and its data and files stay on
-- the server until its admin brings it back (`bookclub undelete`) or purges it (`bookclub purge`).
ALTER TABLE clubs ADD COLUMN deleted_at INTEGER;
ALTER TABLE clubs ADD COLUMN deleted_by TEXT;
ALTER TABLE books ADD COLUMN deleted_at INTEGER;
ALTER TABLE books ADD COLUMN deleted_by TEXT;
