-- Refresh now marks videos removed when they're gone (deleted/private) OR
-- returned but unplayable (embedding disabled, or privacy flipped after the
-- fact — common for ended livestreams; see isPlayable in src/youtube.ts).
-- crawl_log had no way to report how many that was per run, so the /status
-- page couldn't chart it alongside fetched/kept/rejected/added.
ALTER TABLE crawl_log ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
