/** Shared domain types for the Vera-Video catalog. */

export type VideoStatus = "active" | "removed" | "rejected";
export type ChannelPolicy = "allow" | "block" | "neutral";
export type OverrideAction = "include" | "exclude";
export type SourceKind = "search" | "channel_uploads";
export type CrawlKind = "discovery" | "refresh";

/** A video as discovered from YouTube, before it is scored or stored. */
export interface Candidate {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  tags: string[];
}

/** A stored catalog row. */
export interface VideoRow {
  video_id: string;
  title: string;
  description: string;
  channel_id: string;
  channel_title: string;
  published_at: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  tags: string;
  score: number;
  status: VideoStatus;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  checked_at: string | null;
}

export interface SourceRow {
  id: number;
  kind: SourceKind;
  value: string;
  label: string;
  enabled: number;
  page_token: string | null;
  last_crawled_at: string | null;
}

/** The catalog entry shape served to the Android app. */
export interface CatalogVideo {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  tags: string[];
  status: VideoStatus;
  updatedAt: string;
}

export interface CatalogResponse {
  /** Server time the response was generated (ISO 8601). */
  generatedAt: string;
  /** Max updated_at across returned rows; pass back as ?since= for a delta. */
  cursor: string | null;
  /** True when this response is a delta rather than the full catalog. */
  delta: boolean;
  count: number;
  videos: CatalogVideo[];
}
