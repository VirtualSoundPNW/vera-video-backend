/**
 * The two scheduled jobs.
 *
 * Both are deliberately bounded: one source (or one 50-video batch) per run.
 * That keeps each invocation inside the Workers free-tier envelope (10ms CPU,
 * 50 subrequests) and spreads YouTube quota across the day instead of spending
 * it in one burst. Sources rotate least-recently-crawled first, so adding a
 * source slows every source's cadence rather than raising total cost.
 */

import * as db from "./db";
import { config } from "./env";
import { evaluate } from "./filter";
import {
  QUOTA_COST,
  fetchVideoDetails,
  playlistPage,
  searchPage,
  uploadsPlaylistId,
  type Page,
  type VideoDetails,
} from "./youtube";
import type { CrawlKind, SourceRow, VideoStatus } from "./types";

/**
 * Hard ceiling on sources processed per discovery invocation, independent of
 * DISCOVERY_QUOTA_TARGET. Protects the Workers free-tier subrequest budget
 * (50/invocation): one source with results costs ~10 subrequests (2 YouTube
 * calls + ~8 D1 calls for scoring/storage), so 4 sources (~40) leaves margin.
 */
const MAX_SOURCES_PER_RUN = 4;

/** Score a hydrated batch and write it, returning counts for the crawl log. */
async function scoreAndStore(
  env: Env,
  videos: VideoDetails[],
  at: string
): Promise<{ kept: number; rejected: number; added: number }> {
  const { relevanceThreshold } = config(env);
  const videoIds = videos.map((v) => v.videoId);

  const [known, policies, overrides] = await Promise.all([
    db.knownVideoIds(env.DB, videoIds),
    db.channelPolicies(
      env.DB,
      [...new Set(videos.map((v) => v.channelId))].filter(Boolean)
    ),
    db.overridesFor(env.DB, videoIds),
  ]);

  let kept = 0;
  let rejected = 0;

  const rows: db.UpsertVideo[] = videos.map((video) => {
    const decision = evaluate(video, {
      channelPolicy: policies.get(video.channelId) ?? "neutral",
      override: overrides.get(video.videoId) ?? null,
      threshold: relevanceThreshold,
    });

    if (decision.keep) kept++;
    else rejected++;

    const status: VideoStatus = decision.keep ? "active" : "rejected";
    return { ...video, score: decision.score, status };
  });

  // Record channels first so a later operator review can promote them; then the
  // videos themselves.
  await db.recordChannels(
    env.DB,
    videos.filter((v) => v.channelId).map((v) => ({ channelId: v.channelId, title: v.channelTitle })),
    at
  );
  await db.upsertVideos(env.DB, rows, at);

  const added = videoIds.filter((id) => !known.has(id)).length;
  return { kept, rejected, added };
}

/**
 * Crawl one page of a single source, start to finish (its own crawl_log row).
 *
 * search.list costs 100 units and returns only ids, so we always hydrate via
 * videos.list (1 unit) — for one extra unit we get full descriptions, tags and
 * durations, which the relevance filter needs and search snippets don't carry.
 */
async function crawlOneSource(env: Env, source: SourceRow, discoveryPageSize: number): Promise<db.CrawlResult> {
  const at = new Date().toISOString();
  const crawlId = await db.startCrawl(env.DB, "discovery", source.id, at);
  const result: db.CrawlResult = { apiUnits: 0, fetched: 0, kept: 0, rejected: 0, added: 0 };

  try {
    // Quota is billed per request, so charge before awaiting: a call that
    // fails still spent its units and the log must show that.
    let page: Page;
    if (source.kind === "search") {
      result.apiUnits += QUOTA_COST.search;
      page = await searchPage(source.value, source.page_token, discoveryPageSize, env.YOUTUBE_API_KEY);
    } else {
      const playlistId = uploadsPlaylistId(source.value);
      if (!playlistId) throw new Error(`channel_uploads source ${source.id} has a non-UC channel id: ${source.value}`);
      result.apiUnits += QUOTA_COST.playlistItems;
      page = await playlistPage(playlistId, source.page_token, discoveryPageSize, env.YOUTUBE_API_KEY);
    }

    result.fetched = page.videoIds.length;

    if (page.videoIds.length > 0) {
      result.apiUnits += QUOTA_COST.videos;
      const videos = await fetchVideoDetails(page.videoIds, env.YOUTUBE_API_KEY);
      const counts = await scoreAndStore(env, videos, at);
      Object.assign(result, counts);
    }

    // A null nextPageToken means we reached the end; storing null restarts this
    // source from page 1 next rotation, which is how new uploads get picked up.
    await db.advanceSource(env.DB, source.id, page.nextPageToken, at);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error("discovery failed", { sourceId: source.id, error: result.error });
    // Still advance last_crawled_at so one broken source cannot wedge the
    // rotation and starve the others.
    await db.advanceSource(env.DB, source.id, source.page_token, at);
  }

  await db.finishCrawl(env.DB, crawlId, result, new Date().toISOString());
  return result;
}

/**
 * Keep crawling least-recently-crawled sources — the same one repeatedly if
 * it's the only one enabled, paging deeper into its backlog — until spent
 * quota reaches DISCOVERY_QUOTA_TARGET or MAX_SOURCES_PER_RUN sources have
 * been processed, whichever comes first. A cheap channel_uploads source (2
 * units) would otherwise leave most of the quota budget unspent every hour.
 */
export async function runDiscovery(env: Env): Promise<db.CrawlResult> {
  const { discoveryPageSize, discoveryQuotaTarget } = config(env);

  const total: db.CrawlResult = { apiUnits: 0, fetched: 0, kept: 0, rejected: 0, added: 0 };
  let sourcesProcessed = 0;

  while (total.apiUnits < discoveryQuotaTarget && sourcesProcessed < MAX_SOURCES_PER_RUN) {
    const source = await db.pickSource(env.DB);
    if (!source) {
      if (sourcesProcessed === 0) console.warn("discovery: no enabled sources");
      break;
    }

    const result = await crawlOneSource(env, source, discoveryPageSize);
    total.apiUnits += result.apiUnits;
    total.fetched += result.fetched;
    total.kept += result.kept;
    total.rejected += result.rejected;
    total.added += result.added;
    if (result.error && !total.error) total.error = result.error;
    sourcesProcessed++;
  }

  return total;
}

/**
 * Re-check the stalest active videos: refresh titles/thumbnails/durations,
 * mark vanished ones removed, and re-apply the filter so that tuning the rules
 * (or adding an override) eventually propagates to already-stored rows.
 */
export async function runRefresh(env: Env): Promise<db.CrawlResult> {
  const at = new Date().toISOString();
  const { refreshBatchSize } = config(env);

  const crawlId = await db.startCrawl(env.DB, "refresh", null, at);
  const result: db.CrawlResult = { apiUnits: 0, fetched: 0, kept: 0, rejected: 0, added: 0 };

  try {
    const ids = await db.stalestVideoIds(env.DB, refreshBatchSize);
    if (ids.length > 0) {
      result.apiUnits += QUOTA_COST.videos;
      const videos = await fetchVideoDetails(ids, env.YOUTUBE_API_KEY);
      result.fetched = videos.length;

      const returned = new Set(videos.map((v) => v.videoId));
      const missing = ids.filter((id) => !returned.has(id));
      if (missing.length > 0) await db.markRemoved(env.DB, missing, at);

      if (videos.length > 0) {
        const counts = await scoreAndStore(env, videos, at);
        result.kept = counts.kept;
        result.rejected = counts.rejected;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error("refresh failed", { error: result.error });
  }

  await db.finishCrawl(env.DB, crawlId, result, new Date().toISOString());
  return result;
}

/** Map a cron expression to its job. Keep in sync with triggers in wrangler.jsonc. */
export function jobForCron(cron: string): CrawlKind {
  return cron === "45 3 * * *" ? "refresh" : "discovery";
}
