-- Seed discovery sources.
--
-- Only search queries are seeded here. The Vera Project's own channel ID is
-- deliberately NOT hardcoded: inventing a plausible-looking UC... id would
-- silently crawl the wrong channel. Instead the crawler records every channel
-- it encounters into `channels` as 'neutral', so after the first few runs you
-- can find the real one:
--
--   wrangler d1 execute vera-video --remote \
--     --command "SELECT channel_id, title FROM channels ORDER BY title"
--
-- That lookup is read-only and fine to run ad hoc. Promoting a channel is a
-- data change, so it belongs in a new migration file instead — put the
-- UPDATE (policy='allow') and the INSERT OR IGNORE (cheap channel_uploads
-- source, 1 unit/page vs 100 for search) there, following the pattern in
-- 0003_promote_high_yield_channels.sql. That keeps operator tuning under git
-- and reproducible via `npm run db:migrate:remote`, not just live in D1.

INSERT OR IGNORE INTO sources (kind, value, label) VALUES
  ('search', '"The Vera Project"',        'Exact phrase'),
  ('search', 'Vera Project Seattle',      'Venue + city'),
  ('search', 'live at the Vera Project',  'Live sets'),
  ('search', 'Vera Project all ages show','All-ages framing');
