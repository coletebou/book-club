-- A club's plan (D208): free, or Club Pro until a day (or for good). What each plan allows (how
-- much the club may store, how many may join) is the instance's own setting, unlimited unless its
-- host sets a limit; the plan only says which of the host's limits apply.
ALTER TABLE clubs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro'));
ALTER TABLE clubs ADD COLUMN plan_until INTEGER;
