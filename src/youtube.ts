/**
 * Minimal YouTube Data API v3 client.
 *
 * Quota is the binding constraint (10,000 units/day by default). Costs are
 * published as QUOTA_COST so callers can bill themselves *before* awaiting:
 * YouTube charges for the request, not for a successful response, so a failed
 * call still spends units and must still be recorded.
 */

import type { Candidate } from "./types";

const API = "https://www.googleapis.com/youtube/v3";

/** Documented YouTube Data API v3 costs, in quota units per call. */
export const QUOTA_COST = {
  /** Expensive — use sparingly. */
  search: 100,
  /** Prefer whenever a channel is known. */
  playlistItems: 1,
  /** Up to 50 ids per call. */
  videos: 1,
} as const;

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "YouTubeError";
  }
}

export interface Page {
  videoIds: string[];
  nextPageToken: string | null;
}

/** Full details for one video, from videos.list. */
export interface VideoDetails extends Candidate {
  durationSeconds: number | null;
}

async function call(path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new YouTubeError(`youtube ${path} failed: ${res.status}`, res.status, body.slice(0, 500));
  }
  return res.json();
}

/**
 * The uploads playlist of any channel is its id with the "UC" prefix swapped
 * for "UU". Deriving it avoids a channels.list call and is stable YouTube
 * behavior; if a non-UC id is passed we return null rather than guess.
 */
export function uploadsPlaylistId(channelId: string): string | null {
  return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : null;
}

/** Parse ISO 8601 durations as returned by contentDetails.duration (e.g. PT1H2M3S). */
export function parseDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

function bestThumbnail(thumbnails: Record<string, { url?: string }> | undefined): string | null {
  if (!thumbnails) return null;
  for (const size of ["maxres", "standard", "high", "medium", "default"]) {
    const url = thumbnails[size]?.url;
    if (url) return url;
  }
  return null;
}

/** Discover video ids via search. Returns ids only; hydrate with fetchVideoDetails. */
export async function searchPage(
  query: string,
  pageToken: string | null,
  maxResults: number,
  apiKey: string
): Promise<Page> {
  const data = await call(
    "search",
    {
      part: "id",
      q: query,
      type: "video",
      maxResults: String(maxResults),
      order: "date",
      ...(pageToken ? { pageToken } : {}),
    },
    apiKey
  );

  const videoIds: string[] = (data.items ?? [])
    .map((i: any) => i.id?.videoId)
    .filter((id: unknown): id is string => typeof id === "string");

  return { videoIds, nextPageToken: data.nextPageToken ?? null };
}

/** Discover video ids from a channel's uploads playlist. */
export async function playlistPage(
  playlistId: string,
  pageToken: string | null,
  maxResults: number,
  apiKey: string
): Promise<Page> {
  const data = await call(
    "playlistItems",
    {
      part: "contentDetails",
      playlistId,
      maxResults: String(maxResults),
      ...(pageToken ? { pageToken } : {}),
    },
    apiKey
  );

  const videoIds: string[] = (data.items ?? [])
    .map((i: any) => i.contentDetails?.videoId)
    .filter((id: unknown): id is string => typeof id === "string");

  return { videoIds, nextPageToken: data.nextPageToken ?? null };
}

/**
 * Hydrate up to 50 ids into full details. Ids that come back missing are
 * deleted/private/region-blocked — callers treat absence as removal.
 */
export async function fetchVideoDetails(videoIds: string[], apiKey: string): Promise<VideoDetails[]> {
  if (videoIds.length === 0) return [];
  if (videoIds.length > 50) throw new Error("fetchVideoDetails accepts at most 50 ids per call");

  const data = await call("videos", { part: "snippet,contentDetails", id: videoIds.join(",") }, apiKey);

  return (data.items ?? []).map((item: any) => {
    const snippet = item.snippet ?? {};
    return {
      videoId: item.id,
      title: snippet.title ?? "",
      description: snippet.description ?? "",
      channelId: snippet.channelId ?? "",
      channelTitle: snippet.channelTitle ?? "",
      publishedAt: snippet.publishedAt ?? new Date(0).toISOString(),
      thumbnailUrl: bestThumbnail(snippet.thumbnails),
      tags: Array.isArray(snippet.tags) ? snippet.tags : [],
      durationSeconds: item.contentDetails?.duration ? parseDuration(item.contentDetails.duration) : null,
    };
  });
}
