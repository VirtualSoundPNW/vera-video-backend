/**
 * D1 access for the catalog. All queries use prepared statements with bind();
 * never interpolate values into SQL.
 */

import type { CatalogVideo, ChannelPolicy, CrawlKind, OverrideAction, SourceRow, VideoRow, VideoStatus } from "./types";

/** Safety cap on rows returned in one catalog response. */
export const MAX_PAGE = 2000;

/** D1 batches are capped at 1,000 statements on the free plan. */
const MAX_BATCH = 1000;

async function batched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += MAX_BATCH) {
    await db.batch(statements.slice(i, i + MAX_BATCH));
  }
}

/* ------------------------------- sources -------------------------------- */

/** Least-recently-crawled enabled source; NULLs (never crawled) sort first. */
export async function pickSource(db: D1Database): Promise<SourceRow | null> {
  return db
    .prepare(
      `SELECT id, kind, value, label, enabled, page_token, last_crawled_at
         FROM sources
        WHERE enabled = 1
        ORDER BY last_crawled_at IS NOT NULL, last_crawled_at ASC
        LIMIT 1`
    )
    .first<SourceRow>();
}

export async function advanceSource(
  db: D1Database,
  sourceId: number,
  nextPageToken: string | null,
  at: string
): Promise<void> {
  await db
    .prepare(`UPDATE sources SET page_token = ?, last_crawled_at = ? WHERE id = ?`)
    .bind(nextPageToken, at, sourceId)
    .run();
}

/* ------------------------- channels & overrides -------------------------- */

export async function channelPolicies(db: D1Database, channelIds: string[]): Promise<Map<string, ChannelPolicy>> {
  const out = new Map<string, ChannelPolicy>();
  if (channelIds.length === 0) return out;

  const placeholders = channelIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT channel_id, policy FROM channels WHERE channel_id IN (${placeholders})`)
    .bind(...channelIds)
    .all<{ channel_id: string; policy: ChannelPolicy }>();

  for (const row of results) out.set(row.channel_id, row.policy);
  return out;
}

export async function overridesFor(db: D1Database, videoIds: string[]): Promise<Map<string, OverrideAction>> {
  const out = new Map<string, OverrideAction>();
  if (videoIds.length === 0) return out;

  const placeholders = videoIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT video_id, action FROM overrides WHERE video_id IN (${placeholders})`)
    .bind(...videoIds)
    .all<{ video_id: string; action: OverrideAction }>();

  for (const row of results) out.set(row.video_id, row.action);
  return out;
}

/**
 * Record channels the crawler encountered as 'neutral' so an operator can later
 * review and promote them. Existing rows keep their policy (INSERT OR IGNORE).
 */
export async function recordChannels(
  db: D1Database,
  channels: Array<{ channelId: string; title: string }>,
  at: string
): Promise<void> {
  const unique = new Map(channels.map((c) => [c.channelId, c.title]));
  const statements = [...unique].map(([channelId, title]) =>
    db
      .prepare(`INSERT OR IGNORE INTO channels (channel_id, title, policy, first_seen) VALUES (?, ?, 'neutral', ?)`)
      .bind(channelId, title, at)
  );
  await batched(db, statements);
}

/* -------------------------------- videos -------------------------------- */

export interface UpsertVideo {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  tags: string[];
  score: number;
  status: VideoStatus;
}

/**
 * Insert or update videos.
 *
 * `updated_at` only moves when user-visible content actually changes, because
 * it is the delta-sync cursor: bumping it on every crawl would make every
 * client re-download the whole catalog after each run. `last_seen` always moves
 * and is deliberately excluded from that comparison.
 */
export async function upsertVideos(db: D1Database, videos: UpsertVideo[], at: string): Promise<void> {
  const statements = videos.map((v) =>
    db
      .prepare(
        `INSERT INTO videos (
           video_id, title, description, channel_id, channel_title, published_at,
           duration_seconds, thumbnail_url, tags, score, status,
           first_seen, last_seen, updated_at, checked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (video_id) DO UPDATE SET
           title            = excluded.title,
           description      = excluded.description,
           channel_title    = excluded.channel_title,
           published_at     = excluded.published_at,
           duration_seconds = excluded.duration_seconds,
           thumbnail_url    = excluded.thumbnail_url,
           tags             = excluded.tags,
           score            = excluded.score,
           status           = excluded.status,
           last_seen        = excluded.last_seen,
           checked_at       = excluded.checked_at,
           updated_at       = CASE
             WHEN videos.title            IS NOT excluded.title
               OR videos.description      IS NOT excluded.description
               OR videos.channel_title    IS NOT excluded.channel_title
               OR videos.duration_seconds IS NOT excluded.duration_seconds
               OR videos.thumbnail_url    IS NOT excluded.thumbnail_url
               OR videos.tags             IS NOT excluded.tags
               OR videos.status           IS NOT excluded.status
             THEN excluded.updated_at
             ELSE videos.updated_at
           END`
      )
      .bind(
        v.videoId,
        v.title,
        v.description,
        v.channelId,
        v.channelTitle,
        v.publishedAt,
        v.durationSeconds,
        v.thumbnailUrl,
        JSON.stringify(v.tags),
        v.score,
        v.status,
        at,
        at,
        at,
        at
      )
  );
  await batched(db, statements);
}

/** Active videos not checked recently; NULL checked_at (never checked) first. */
export async function stalestVideoIds(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT video_id FROM videos
        WHERE status = 'active'
        ORDER BY checked_at IS NOT NULL, checked_at ASC
        LIMIT ?`
    )
    .bind(limit)
    .all<{ video_id: string }>();
  return results.map((r) => r.video_id);
}

/** A video YouTube no longer returns is gone (deleted/private); tell clients. */
export async function markRemoved(db: D1Database, videoIds: string[], at: string): Promise<void> {
  const statements = videoIds.map((id) =>
    db
      .prepare(`UPDATE videos SET status = 'removed', updated_at = ?, checked_at = ? WHERE video_id = ? AND status != 'removed'`)
      .bind(at, at, id)
  );
  await batched(db, statements);
}

/* ------------------------------- catalog -------------------------------- */

function toCatalogVideo(row: VideoRow): CatalogVideo {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed;
  } catch {
    // Malformed tags must not break the whole response; an empty list is fine.
  }
  return {
    videoId: row.video_id,
    title: row.title,
    description: row.description,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_url,
    tags,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

const CATALOG_COLUMNS = `video_id, title, description, channel_id, channel_title, published_at,
  duration_seconds, thumbnail_url, tags, score, status, first_seen, last_seen, updated_at, checked_at`;

/** Full catalog: active videos only, newest first. */
export async function fullCatalog(db: D1Database, limit = MAX_PAGE): Promise<CatalogVideo[]> {
  const { results } = await db
    .prepare(`SELECT ${CATALOG_COLUMNS} FROM videos WHERE status = 'active' ORDER BY published_at DESC LIMIT ?`)
    .bind(limit)
    .all<VideoRow>();
  return results.map(toCatalogVideo);
}

/**
 * Delta: everything touched since `since`, ordered by the cursor column.
 * Includes 'removed' rows so clients can prune, but never 'rejected' ones —
 * those were filtered out and were never visible to clients in the first place.
 */
export async function catalogSince(db: D1Database, since: string, limit = MAX_PAGE): Promise<CatalogVideo[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CATALOG_COLUMNS} FROM videos
        WHERE updated_at > ? AND status IN ('active', 'removed')
        ORDER BY updated_at ASC
        LIMIT ?`
    )
    .bind(since, limit)
    .all<VideoRow>();
  return results.map(toCatalogVideo);
}

/** Cheap fingerprint of catalog state, used for the ETag. */
export async function catalogMeta(db: D1Database): Promise<{ count: number; maxUpdated: string | null }> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count, MAX(updated_at) AS max_updated FROM videos WHERE status = 'active'`)
    .first<{ count: number; max_updated: string | null }>();
  return { count: row?.count ?? 0, maxUpdated: row?.max_updated ?? null };
}

/* ------------------------------ crawl log ------------------------------- */

export async function startCrawl(db: D1Database, kind: CrawlKind, sourceId: number | null, at: string): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO crawl_log (kind, source_id, started_at) VALUES (?, ?, ?) RETURNING id`)
    .bind(kind, sourceId, at)
    .first<{ id: number }>();
  return row!.id;
}

export interface CrawlResult {
  apiUnits: number;
  fetched: number;
  kept: number;
  rejected: number;
  added: number;
  error?: string;
}

export async function finishCrawl(db: D1Database, id: number, result: CrawlResult, at: string): Promise<void> {
  await db
    .prepare(
      `UPDATE crawl_log
          SET finished_at = ?, api_units = ?, fetched = ?, kept = ?, rejected = ?, added = ?, error = ?
        WHERE id = ?`
    )
    .bind(at, result.apiUnits, result.fetched, result.kept, result.rejected, result.added, result.error ?? null, id)
    .run();
}

export async function recentCrawls(db: D1Database, limit = 20): Promise<unknown[]> {
  const { results } = await db
    .prepare(`SELECT * FROM crawl_log ORDER BY started_at DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results;
}

/** Video ids already known, so the crawler can count genuinely new discoveries. */
export async function knownVideoIds(db: D1Database, videoIds: string[]): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set();
  const placeholders = videoIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT video_id FROM videos WHERE video_id IN (${placeholders})`)
    .bind(...videoIds)
    .all<{ video_id: string }>();
  return new Set(results.map((r) => r.video_id));
}
