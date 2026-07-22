# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**vera-video-backend** — a Cloudflare Worker that crawls the YouTube Data API on
a cron, builds a filtered catalog of videos related to The Vera Project (the
Seattle all-ages venue), and serves it as a small read-only JSON API.

The consumer is the **Vera-Video** Android app, in a separate repo
(`../vera-video` / `VirtualSoundPNW/vera-video`). The app never calls YouTube
directly: it syncs `GET /catalog` into a local Room database and searches that.
Doing the crawl here keeps the API key server-side and spends one quota budget
instead of one per device.

See [README.md](README.md) for setup, the API shape, and how the crawler works.

## Commands

```bash
npm run dev                # local worker on :8787
npm test                   # vitest, running in the real Workers runtime
npm run typecheck          # regenerates worker types, then tsc
npm run db:migrate:local   # apply D1 schema locally
npm run deploy
```

Trigger the cron jobs by hand against `wrangler dev` — note the path is
`/cdn-cgi/handler/scheduled`, **not** `/__scheduled` (which older docs and the
Cloudflare skill still show; it falls through to the Hono router and 404s):

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/20+*+*+*+*"  # discovery
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+3+*+*+*"    # refresh
curl "http://localhost:8787/stats"                                        # inspect result
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Hono routes + cron dispatch (`jobForCron`) |
| `src/crawler.ts` | The two scheduled jobs |
| `src/youtube.ts` | YouTube Data API client, `QUOTA_COST` |
| `src/filter.ts` | Relevance scoring |
| `src/db.ts` | All D1 access |
| `src/env.ts` | Var parsing (`Env` itself is ambient — see below) |
| `src/charts.ts` | Dependency-free inline SVG chart helpers |
| `src/status.ts` | Data gathering + HTML for `GET /status` |
| `migrations/` | D1 schema |

## Design decisions worth knowing before changing things

- **Each cron run is deliberately bounded**, just not to a single source
  anymore. Discovery loops sources (repeating the same one if it's the only
  one enabled, to page deeper into a backlog) until it spends
  `DISCOVERY_QUOTA_TARGET` — cheap `channel_uploads` sources (2 units) would
  otherwise leave most of an hour's budget unused. `MAX_SOURCES_PER_RUN` in
  `crawler.ts` (currently 4) is the real safety bound: it protects the
  Workers free tier's **10 ms CPU, 50 subrequests/invocation** ceiling
  independent of the quota target, since one source with results costs ~10
  subrequests. Refresh stays bounded to one 50-video batch. Raising
  `MAX_SOURCES_PER_RUN` needs the subrequest math re-checked, not just a
  bigger number.
- **Quota is billed per request, not per success.** `crawler.ts` adds
  `QUOTA_COST.*` *before* awaiting, so a failed call still shows up in
  `crawl_log`. Moving that after the await understates real burn.
- **Discovery always hydrates via `videos.list`.** `search.list` returns ids
  only and its snippets lack tags/full descriptions/duration; one extra quota
  unit buys the filter much better input.
- **Prefer `playlistItems.list` over `search.list`** wherever a channel is known:
  1 unit/page vs 100.
- **`updated_at` is the delta-sync cursor**, and `upsertVideos` only advances it
  when user-visible content actually changed. Bumping it on every crawl would
  make every client re-download the whole catalog after each run. `last_seen`
  always moves and is deliberately excluded from that comparison.
- **Videos are never hard-deleted**; a vanished video becomes `status='removed'`
  so clients can prune. `rejected` rows are kept too, for filter tuning.
- **`refresh` only re-scores `status='active'` rows** (`stalestVideoIds`
  filters on it). A filter change that should *rescue* previously-rejected
  videos won't reach them on its own — check for stuck `rejected` rows
  matching the new rule and flip them by hand (or via `overrides`) after any
  change that loosens the filter.
- **A broken source must not wedge the rotation** — discovery advances
  `last_crawled_at` even on failure, but preserves `page_token` so no page is
  skipped.
- **The Vera Project's channel ID is deliberately not hardcoded.** Inventing a
  plausible `UC...` would silently crawl the wrong channel. The crawler records
  every channel it meets as `neutral` for an operator to promote (see README).
- **`GET /status` is gated by `?key=` against `STATUS_PAGE_KEY`, not public.**
  A wrong/missing key 404s rather than 401/403, so a scanner can't tell the
  route exists. Because the secret rides in the URL, the response always sets
  `Cache-Control: private, no-store` — don't let that regress or the key can
  leak into a shared/edge cache.

### The filter is the part that needs tuning

The Vera Project operates two venues, both accepted by the filter: the venue
itself, and **Black Lodge** (Eastlake Ave, Seattle — reopened by Vera in 2021).
Both names are overloaded. "Vera" collides with Vera Rubin Observatory, Vera
Wang, aloe vera, the ITV series, and a radio-astronomy program *also* called
"the VERA project". "Black Lodge" collides with Twin Peaks, where it's the
dominant sense of the phrase on YouTube. `src/filter.ts` scores candidates;
precedence is **override → channel policy → keyword score**. The weights are
a starting point, not truth — `crawl_log` and `GET /stats` exist to tune them
against real results. `test/filter.test.ts` pins the specific disambiguations
for both venues; keep adding cases there rather than tweaking weights blind.

## Toolchain gotchas

- **`Env` is ambient and gitignored.** `wrangler types` generates
  `worker-configuration.d.ts` from the bindings in `wrangler.jsonc` *plus* the
  keys in `.dev.vars`; it supersedes `@cloudflare/workers-types` (do not
  reinstall that). Don't hand-write an `Env` interface — run `npm run cf-typegen`.
  `npm run typecheck` regenerates it first, which is why CI copies
  `.dev.vars.example` into place.
- **vitest-pool-workers v0.18 changed API.** It is the `cloudflareTest()` *Vite
  plugin* from the package root — `defineWorkersConfig` and the
  `/config` subpath no longer exist. Types come from
  `@cloudflare/vitest-pool-workers/types`. There is no `fetchMock` in this
  version; `test/crawler.test.ts` stubs global `fetch` with `vi.stubGlobal`.
- **D1/SQLite has no booleans or dates.** Booleans are INTEGER 0/1; timestamps
  are TEXT in ISO 8601 UTC (which sorts lexicographically).
- **Always use prepared statements with `bind()`** — never interpolate values
  into SQL. Chunk `IN (...)` lists; D1 batches cap at 1,000 statements on free.

## Hard constraints

- **Never commit secrets.** `YOUTUBE_API_KEY` and `STATUS_PAGE_KEY` live in
  `.dev.vars` (gitignored) locally and `wrangler secret put` in production.
  `.dev.vars.example` is the only one that gets committed.
- **Watch the quota.** Default is 10,000 units/day. With `DISCOVERY_QUOTA_TARGET`
  batching multiple sources into busier runs, actual daily spend depends on
  the mix of sources hit each run — up to ~7,200 in the theoretical worst case
  (every one of the 72 twenty-minute runs reaching the full 100-unit target),
  likely less in practice since a cheap-source-heavy run hits
  `MAX_SOURCES_PER_RUN` before it can reach the target. Check `GET /status`
  for the real number. Any change that raises `search.list` frequency, page
  depth, source count, `DISCOVERY_QUOTA_TARGET`, or the cron cadence needs to
  be checked against that budget — there's not much headroom left above
  ~7,200/day without risking the 10,000 cap on a bad day.
- **YouTube ToS**: this service only reads metadata via the official API. Video
  playback is the app's problem and must stay in the embedded IFrame player — do
  not add stream extraction or downloading here.
