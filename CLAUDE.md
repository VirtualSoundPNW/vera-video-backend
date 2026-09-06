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
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"     # discovery
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+*+*+*+*"    # refresh
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
  anymore. Discovery loops sources until it spends `DISCOVERY_QUOTA_TARGET`
  or hits `MAX_SOURCES_PER_RUN` in `crawler.ts` (currently 4) — the latter is
  the real safety bound: it protects the Workers free tier's **10 ms CPU, 50
  subrequests/invocation** ceiling independent of the quota target, since one
  source with results costs ~10 subrequests. Refresh stays bounded to one
  50-video batch. Raising `MAX_SOURCES_PER_RUN` needs the subrequest math
  re-checked, not just a bigger number.
- **Search and channel sources are budgeted separately.** Search sources run
  on a per-source cadence (`SEARCH_INTERVAL_MINUTES`) with first claim on a
  run when due; all other runs fill with least-recently-crawled
  `channel_uploads` sources. Don't fold them back into one LRU rotation: the
  channel pool grows via auto-promotion, and in a shared rotation hundreds of
  cheap channel sources would starve the searches — the only mechanism that
  discovers *new* channels — down to ~1 crawl/day.
- **Channels are auto-promoted to sources, not to trust.** After each search
  crawl, `autoPromoteChannels` adds any channel with
  `AUTO_PROMOTE_MIN_ACTIVE` filter-accepted videos as a `channel_uploads`
  source (label suffixed `(auto)`), leaving `channels.policy` at `neutral` so
  its uploads are still scored. Setting `policy='allow'` (skip scoring) stays
  a manual operator decision. Auto-added source rows are runtime data —
  reproducible by re-crawling — so they don't need a migration, unlike
  operator tuning.
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
- **"Vanished" includes unplayable, not just absent.** `videos.list` keeps
  returning full metadata for a video whose owner made it private or disabled
  embedding — it hasn't disappeared from the API, but it's still unplayable in
  the app's embedded IFrame player. `runRefresh` treats both cases (missing
  entirely, or returned but failing `isPlayable` in `src/youtube.ts`) as
  removed. This is common for ended livestreams, which is why "video
  unavailable" reports skew toward `[LIVE]`-titled videos — but the title
  itself is not the signal to check.
- **`refresh` now runs hourly** (`45 * * * *`, offset from discovery's `:00`)
  instead of nightly, specifically so this playability check reaches the
  whole active catalog roughly weekly instead of over months — at
  `REFRESH_BATCH_SIZE=30` that's 24 × 30 = 720 checks/day for +24 quota
  units/day. Raising the batch size or adding a separate cron for this needs
  the same daily-checks-vs-catalog-size math re-done.
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
  Promotions and other `sources`/`channels` tuning belong in a new migration
  file, not a raw `wrangler d1 execute` write — see
  `migrations/0003_promote_high_yield_channels.sql` for the pattern. That
  keeps operator tuning under git, not just live in D1.
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
- **Watch the quota.** Default is 10,000 units/day. Spend is governed almost
  entirely by search cadence: `enabled searches × (1440 /
  SEARCH_INTERVAL_MINUTES) × ~101` units, capped at 24 search runs/day (one
  search per cron invocation, enforced in `runDiscovery`). The defaults (7
  searches, 420 min, `DISCOVERY_QUOTA_TARGET=110`) sit exactly at that cap:
  every hourly run does one search plus ~3 cheap channel fills, ~24 × 107
  ≈ 2,570/day (~26% of the cap). The cron was cut from every 20 minutes to
  hourly — new videos are rare enough that 3x less frequent checking is
  plenty, and `SEARCH_INTERVAL_MINUTES` was tripled alongside it (140 → 420)
  to stay matched to the new invocation cap. Check `GET /status` for the
  real number. Enabling more search sources no longer raises spend past the
  24-run ceiling — it spreads the same budget across more queries; adding
  channel sources is nearly free quota-wise but stretches how often each
  channel gets re-checked (~72 channel visits/day across the whole pool).
  Any change to those knobs, `MAX_SOURCES_PER_RUN`, or the cron cadence
  needs re-checking against the 10,000 cap. Refresh's hourly cron adds a flat
  +24 units/day on top of that (1 unit/run regardless of `REFRESH_BATCH_SIZE`,
  since a `videos.list` call is billed per call, not per id) — negligible, but
  count it if you also raise discovery's spend closer to the cap.
- **YouTube ToS**: this service only reads metadata via the official API. Video
  playback is the app's problem and must stay in the embedded IFrame player — do
  not add stream extraction or downloading here.
