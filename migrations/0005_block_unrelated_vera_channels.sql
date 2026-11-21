-- Operator tuning, 2026-11-21: two YouTube channels share the venue's name but
-- have nothing to do with it, and every upload passes the filter on the name
-- alone (the channel title is part of the scored text, so "The Vera Project"
-- in the channel name is a decisive name match on every video):
--
--   UCenM4X5osBNJOwz3SWVSJNw  "The Vera Project" - a misinformation /
--     fact-checking channel ("VERA: Verification. Evidence. Research.
--     Analysis."). 4 active videos, e.g. "Russell Crowe: A Decade of
--     Misinformation". It had also been auto-promoted to a channel_uploads
--     source (id 277), so its uploads were mined directly.
--   UC7RX9faQZDX0ZjDzG4Y6KHg  "VERA Project" - an EU public-health/AI
--     research project (University of Malta interviews). 1 active video.
--
-- Not blocked: "Big Shots Media" (UCwLVh8FoeQjaCQkGDzjK6ZQ). Its 2 active
-- videos are a fashion show held at The Vera Project on 2026-10-17, which the
-- descriptions say; its other 14 uploads were already rejected by scoring.
--
-- 1. Block both channels, so future uploads are rejected without scoring.
UPDATE channels
   SET policy = 'block',
       notes  = 'Unrelated channel sharing the venue name (0005)'
 WHERE channel_id IN ('UCenM4X5osBNJOwz3SWVSJNw', 'UC7RX9faQZDX0ZjDzG4Y6KHg');

-- 2. Stop crawling the fact-checking channel's uploads.
UPDATE sources
   SET enabled = 0
 WHERE kind = 'channel_uploads' AND value = 'UCenM4X5osBNJOwz3SWVSJNw';

-- 3. Take their videos out of the catalog now. 'removed' (not 'rejected') is
--    the status /catalog?since= delta sync sends to clients, so installed
--    apps prune them on their next sync; refresh would only have flipped them
--    to 'rejected', which delta sync never sends.
UPDATE videos
   SET status     = 'removed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE channel_id IN ('UCenM4X5osBNJOwz3SWVSJNw', 'UC7RX9faQZDX0ZjDzG4Y6KHg')
   AND status = 'active';
