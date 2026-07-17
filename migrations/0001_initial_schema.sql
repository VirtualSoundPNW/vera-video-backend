-- Vera-Video catalog schema.
-- SQLite/D1 has no native boolean or date types: booleans are INTEGER 0/1,
-- timestamps are TEXT in ISO 8601 (UTC), which sorts lexicographically.

-- Videos discovered by the crawler. Rows are never hard-deleted; a video that
-- disappears from YouTube is kept with status 'removed' so clients can prune.
CREATE TABLE IF NOT EXISTS videos (
  video_id         TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  channel_id       TEXT NOT NULL,
  channel_title    TEXT NOT NULL DEFAULT '',
  published_at     TEXT NOT NULL,
  duration_seconds INTEGER,
  thumbnail_url    TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  score            INTEGER NOT NULL DEFAULT 0,   -- relevance score at last evaluation
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'removed', 'rejected')),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  updated_at       TEXT NOT NULL,                -- drives ?since= delta sync + ETag
  checked_at       TEXT                          -- last videos.list refresh
);

-- Delta sync: GET /catalog?since=<ts> orders by updated_at.
CREATE INDEX IF NOT EXISTS idx_videos_updated_at ON videos (updated_at);
-- Default catalog listing: active videos, newest first.
CREATE INDEX IF NOT EXISTS idx_videos_status_published ON videos (status, published_at DESC);
-- Refresh pass picks the stalest rows.
CREATE INDEX IF NOT EXISTS idx_videos_checked_at ON videos (checked_at);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos (channel_id);

-- Channels seen by the crawler. 'allow' short-circuits the relevance filter,
-- 'block' rejects outright, 'neutral' falls through to keyword scoring.
-- The crawler auto-inserts channels it encounters as 'neutral' so an operator
-- can review and promote them without hunting for channel IDs by hand.
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  policy     TEXT NOT NULL DEFAULT 'neutral'
             CHECK (policy IN ('allow', 'block', 'neutral')),
  notes      TEXT,
  first_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_policy ON channels (policy);

-- Manual per-video decisions. Beats both channel policy and keyword scoring.
CREATE TABLE IF NOT EXISTS overrides (
  video_id   TEXT PRIMARY KEY,
  action     TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
  reason     TEXT,
  created_at TEXT NOT NULL
);

-- What the discovery crawler walks through, one source per run.
--   kind='search'          -> value is a YouTube search query (100 quota units/page)
--   kind='channel_uploads' -> value is a channel_id; the uploads playlist is
--                             derived as UC... -> UU... (1 quota unit/page)
CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('search', 'channel_uploads')),
  value           TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  page_token      TEXT,           -- resume token; NULL means start from page 1
  last_crawled_at TEXT,
  UNIQUE (kind, value)
);

-- Rotation: least-recently-crawled enabled source wins.
CREATE INDEX IF NOT EXISTS idx_sources_rotation ON sources (enabled, last_crawled_at);

-- One row per crawl run. Exists to debug quota burn and filter behavior, which
-- is the main thing needing tuning ("Vera" matches a lot of unrelated video).
CREATE TABLE IF NOT EXISTS crawl_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('discovery', 'refresh')),
  source_id   INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  api_units   INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0,
  kept        INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_log_started ON crawl_log (started_at DESC);
