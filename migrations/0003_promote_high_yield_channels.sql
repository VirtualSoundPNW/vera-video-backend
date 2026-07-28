-- Operator tuning, 2026-07-28: discovery had gone stale (added videos/day
-- falling toward 0 while quota stayed pinned at ~7400) because our 5 search
-- sources were paging through a finite, shrinking backlog. Investigation via
-- crawl_log/channels showed several 'neutral' channels already sitting at a
-- ~100% relevance hit rate, only getting re-crawled when they happened to
-- resurface in an expensive 100-unit search.list call.
--
-- This migration is a data-only change (same pattern as 0002_seed_sources):
--  1. Promote those channels to 'allow' so future videos skip scoring, and
--     add them as cheap (1 unit/page) channel_uploads sources so their full
--     upload history gets mined directly instead of waiting on search.
--  2. Disable source id 4 ("Vera Project all ages show") — 0 videos added
--     for a full week at 100 units/run, pure dead weight.
--  3. Add more Black Lodge search variants — 4 of the original 5 search
--     sources targeted "Vera Project" phrasing and only 1 targeted the
--     second venue, despite Black Lodge (reopened 2021) being newer and
--     less indexed.

UPDATE channels SET policy = 'allow' WHERE channel_id IN (
  'UC7xj2aDfZqd4ByUpUo-PkyA', -- Klaydawg Barks (137/137 active)
  'UCrw67tL_c-Htu9UiAcflX-Q', -- chris williams (42/42 active)
  'UCOxC7unCQqO_oecUSyoOb8Q', -- snorkboy89 (31/31 active)
  'UCFofKGo6IEJd9T0DR6kKNag', -- Kissing the War Goodbye (28/29 active)
  'UCAWGT36Z-6k-c2cNIsKTZrQ', -- bentley rogers (26/26 active)
  'UC96Be1h9DJSDNiqK89HOYfA', -- Campfire Island (20/20 active)
  'UCI9iKjGm3SFGx6gYUonyUug'  -- TheGoldenNeedle (19/19 active)
);

INSERT OR IGNORE INTO sources (kind, value, label) VALUES
  ('channel_uploads', 'UC7xj2aDfZqd4ByUpUo-PkyA', 'Klaydawg Barks uploads'),
  ('channel_uploads', 'UCrw67tL_c-Htu9UiAcflX-Q', 'chris williams uploads'),
  ('channel_uploads', 'UCOxC7unCQqO_oecUSyoOb8Q', 'snorkboy89 uploads'),
  ('channel_uploads', 'UCFofKGo6IEJd9T0DR6kKNag', 'Kissing the War Goodbye uploads'),
  ('channel_uploads', 'UCAWGT36Z-6k-c2cNIsKTZrQ', 'bentley rogers uploads'),
  ('channel_uploads', 'UC96Be1h9DJSDNiqK89HOYfA', 'Campfire Island uploads'),
  ('channel_uploads', 'UCI9iKjGm3SFGx6gYUonyUug', 'TheGoldenNeedle uploads'),
  ('search', 'live at Black Lodge Seattle',   'Black Lodge live sets'),
  ('search', 'Black Lodge Eastlake',          'Black Lodge + street'),
  ('search', 'Black Lodge all ages Seattle',  'Black Lodge all-ages framing');

UPDATE sources SET enabled = 0 WHERE id = 4;
