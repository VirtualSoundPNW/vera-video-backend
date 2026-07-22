# vera-video-backend

Back end for the [Vera-Video](https://github.com/VirtualSoundPNW/vera-video) Android app.

It uses the YouTube Data API to build and periodically refresh a catalog of
videos related to **The Vera Project**, filters out the many unrelated things
named "Vera", and serves the result as a small JSON API.

```
YouTube Data API ──cron──▶ this Worker ──▶ D1 ──▶ GET /catalog ──▶ Android app
```

The app never calls YouTube directly. Doing the crawl here keeps the API key
server-side, spends one quota budget instead of one per device, and lets the app
search instantly against a local copy of the catalog.

## Stack

TypeScript on **Cloudflare Workers**, with **D1** (SQLite) for the catalog and
**Cron Triggers** for scheduling. The workload is a periodic job plus a
read-only endpoint, so there is no server to run and it fits in the free tier.
Routing uses **Hono**; tests run in the real Workers runtime via
`@cloudflare/vitest-pool-workers`.

## API

| Endpoint | Purpose |
|---|---|
| `GET /catalog` | Full catalog: active videos, newest first. |
| `GET /catalog?since=<iso8601>` | Delta: only rows changed since the cursor, including removals so clients can prune. |
| `GET /stats` | Catalog size and recent crawl history. |
| `GET /status?key=<STATUS_PAGE_KEY>` | Human-readable dashboard: videos over time, quota burn, crawl errors, endpoint traffic. Gated by a secret key; wrong/missing key 404s. |
| `GET /health` | Liveness. |

Responses carry an `ETag`; send it back as `If-None-Match` to get a `304`.
Each response includes a `cursor` — pass it as `since` on the next sync.

```jsonc
{
  "generatedAt": "2026-07-16T19:52:57.290Z",
  "cursor": "2026-07-16T03:45:00.000Z",
  "delta": false,
  "count": 2,
  "videos": [
    {
      "videoId": "…", "title": "…", "description": "…",
      "channelId": "…", "channelTitle": "…",
      "publishedAt": "2026-05-01T00:00:00Z",
      "durationSeconds": 222, "thumbnailUrl": "…", "tags": ["…"],
      "status": "active", "updatedAt": "2026-07-16T03:45:00.000Z"
    }
  ]
}
```

## How the crawler works

Two cron schedules, dispatched by `controller.cron` in `src/index.ts`:

- **Discovery** (`0 * * * *`, hourly) — crawls **one** source per run, picking
  the least-recently-crawled one. Search sources cost 100 quota units per
  page; results are then hydrated with a `videos.list` call (1 unit) because
  search snippets carry no tags, truncated descriptions and no duration — one
  extra unit buys much better filtering input. Channel sources cost 1 unit/page
  via `playlistItems.list` instead. ~101 units/run for a search source, ~2 for
  a channel one.
- **Refresh** (`45 3 * * *`) — re-checks the 50 stalest videos in one
  `videos.list` call (1 unit): updates metadata, marks vanished videos
  `removed`, and re-applies the filter so rule changes reach existing rows.

Each run is deliberately bounded to one source or one batch. That keeps every
invocation inside the free-tier envelope (10 ms CPU, 50 subrequests). With 9
rotating sources (4 search, 5 channel uploads) and hourly discovery, the total
is ~1,100 of the 10,000 daily units — there's room to add more of either kind
before the cadence or source count needs to trade off against quota.

### Relevance filtering

"Vera" is noisy — the Vera Rubin Observatory, Vera Wang, aloe vera, the ITV
series, and a radio-astronomy program also called "the VERA project" all compete
with the venue. `src/filter.ts` scores candidates and keeps those at or above
`RELEVANCE_THRESHOLD`. Precedence:

1. **manual override** (`overrides` table) — always wins
2. **channel policy** (`channels.policy` = `allow` / `block`)
3. **keyword score** — the venue's name scores positive, supporting context
   (Seattle, all-ages, live at Vera) adds a capped bonus, and decisive
   disambiguations (`vera rubin`, `aloe vera`, `vlbi`, …) subtract.

These weights are a starting point, not truth. `GET /stats` and the `crawl_log`
table exist to tune them against real results.

The crawler records every channel it meets into `channels` as `neutral`, so you
can review and promote them without hunting for channel IDs:

```bash
wrangler d1 execute vera-video --remote --command \
  "SELECT channel_id, title FROM channels ORDER BY title"

wrangler d1 execute vera-video --remote --command \
  "UPDATE channels SET policy='allow' WHERE channel_id='UC…'"

# Then crawl its uploads at 1 unit/page instead of 100:
wrangler d1 execute vera-video --remote --command \
  "INSERT INTO sources (kind, value, label) VALUES ('channel_uploads','UC…','Vera uploads')"
```

## Setup

```bash
npm install

# 1. Create the database, then put the printed id into wrangler.jsonc.
npx wrangler d1 create vera-video

# 2. Apply the schema.
npm run db:migrate:local     # local
npm run db:migrate:remote    # production

# 3. Provide a YouTube Data API v3 key and a status-page key.
cp .dev.vars.example .dev.vars            # local: paste both in (STATUS_PAGE_KEY can be anything)
npx wrangler secret put YOUTUBE_API_KEY   # production
npx wrangler secret put STATUS_PAGE_KEY   # production

# 4. Run it.
npm run dev
```

Get an API key from the [Google Cloud console](https://console.cloud.google.com/):
create a project, enable **YouTube Data API v3**, create an API key, and
restrict it to that API.

## Development

```bash
npm run dev         # local worker at http://localhost:8787
npm test            # runs in the real Workers runtime
npm run typecheck   # regenerates worker types, then tsc
npm run deploy
```

Trigger the cron jobs by hand against `wrangler dev`:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*/6+*+*+*"   # discovery
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+3+*+*+*"    # refresh
curl "http://localhost:8787/stats"                                        # inspect the result
```

`Env` is generated by `wrangler types` into `worker-configuration.d.ts` (from
the bindings in `wrangler.jsonc` plus the keys in `.dev.vars`). It is
gitignored; `npm run typecheck` regenerates it. Re-run `npm run cf-typegen`
after changing bindings.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Hono routes and cron dispatch |
| `src/crawler.ts` | The two scheduled jobs |
| `src/youtube.ts` | YouTube Data API client and quota costs |
| `src/filter.ts` | Relevance scoring |
| `src/db.ts` | D1 queries |
| `src/charts.ts` | Dependency-free inline SVG charts |
| `src/status.ts` | Data gathering and HTML for `GET /status` |
| `migrations/` | D1 schema |

## License

Apache-2.0 — see [LICENSE](LICENSE).
