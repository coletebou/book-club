-- How many times reading an edition's files has started since it last ended, ready or failed. One
-- still being read when the server stops is read again at the next start; one that stopped the
-- server every time (a file that runs it out of memory) would do so for ever, so after a few it is
-- marked failed instead.
ALTER TABLE editions ADD COLUMN ingest_starts INTEGER NOT NULL DEFAULT 0;
