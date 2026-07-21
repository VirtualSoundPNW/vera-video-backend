-- HTTP endpoint usage, aggregated per (day, path) rather than per-request so
-- this stays a handful of rows (routes x days) instead of growing unbounded.
-- Powers the /status page's traffic and error-rate charts.
CREATE TABLE IF NOT EXISTS endpoint_stats (
  day    TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  path   TEXT NOT NULL,              -- e.g. '/catalog' — all current routes are static
  hits   INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, -- status >= 500
  PRIMARY KEY (day, path)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_stats_day ON endpoint_stats (day);
