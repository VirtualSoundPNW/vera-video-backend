-- Seed discovery sources.
--
-- Only search queries are seeded here. The Vera Project's own channel ID is
-- deliberately NOT hardcoded: inventing a plausible-looking UC... id would
-- silently crawl the wrong channel. Instead the crawler records every channel
-- it encounters into `channels` as 'neutral', so after the first few runs you
-- can find the real one and promote it:
--
--   wrangler d1 execute vera-video --remote \
--     --command "SELECT channel_id, title FROM channels ORDER BY title"
--
--   wrangler d1 execute vera-video --remote \
--     --command "UPDATE channels SET policy='allow' WHERE channel_id='UC...'"
--
--   -- then crawl its uploads cheaply (1 quota unit/page vs 100 for search):
--   wrangler d1 execute vera-video --remote \
--     --command "INSERT INTO sources (kind, value, label) \
--                VALUES ('channel_uploads', 'UC...', 'Vera Project uploads')"

INSERT OR IGNORE INTO sources (kind, value, label) VALUES
  ('search', '"The Vera Project"',        'Exact phrase'),
  ('search', 'Vera Project Seattle',      'Venue + city'),
  ('search', 'live at the Vera Project',  'Live sets'),
  ('search', 'Vera Project all ages show','All-ages framing');
