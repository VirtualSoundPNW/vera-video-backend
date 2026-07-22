/** Data gathering and HTML rendering for the operator-only GET /status page. */

import { barChart, sparkline, type Point } from "./charts";
import * as db from "./db";

/** YouTube's default per-project cap; not something this app configures. */
const DAILY_QUOTA_CAP = 10_000;

/**
 * Preset time-range options for the charts. A fixed list (rather than any
 * integer) keeps the D1 queries cheap and predictable, matches the pattern
 * `since` validation uses on `/catalog`, and keeps the range picker UI simple
 * (a handful of links) with no client JS.
 */
export const WINDOW_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_WINDOW_DAYS = 30;

export function parseWindowDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return (WINDOW_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

export interface StatusData {
  windowDays: number;
  activeVideos: number;
  lastUpdated: string | null;
  videosByStatus: Record<string, number>;
  videosAddedByDay: db.DayCount[];
  quotaUsedToday: number;
  quotaUsedByDay: db.DayCount[];
  recentCrawlErrors: unknown[];
  endpointUsage: db.EndpointUsage[];
  endpointHitsByDay: db.DayCount[];
}

export async function gatherStatusData(d1: D1Database, windowDays: number): Promise<StatusData> {
  const [meta, statusCounts, videosByDay, quotaToday, quotaByDay, errors, usage, hitsByDay] = await Promise.all([
    db.catalogMeta(d1),
    db.videosByStatus(d1),
    db.videosAddedByDay(d1, windowDays),
    db.quotaUsedToday(d1),
    db.quotaUsedByDay(d1, windowDays),
    db.recentCrawlErrors(d1, 20),
    db.endpointUsage(d1, windowDays),
    db.endpointHitsByDay(d1, windowDays),
  ]);

  return {
    windowDays,
    activeVideos: meta.count,
    lastUpdated: meta.maxUpdated,
    videosByStatus: statusCounts,
    videosAddedByDay: videosByDay,
    quotaUsedToday: quotaToday,
    quotaUsedByDay: quotaByDay,
    recentCrawlErrors: errors,
    endpointUsage: usage,
    endpointHitsByDay: hitsByDay,
  };
}

function toPoints(rows: db.DayCount[]): Point[] {
  return rows.map((r) => ({ label: r.day, value: r.count }));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function errorRow(row: unknown): string {
  const r = row as { started_at: string; kind: string; error: string };
  return `<tr><td>${escapeHtml(r.started_at)}</td><td>${escapeHtml(r.kind)}</td><td>${escapeHtml(r.error)}</td></tr>`;
}

/** Range-picker links that preserve the secret key and just swap `days`. */
function rangePicker(key: string, activeDays: number): string {
  const links = WINDOW_OPTIONS.map((days) => {
    const href = `?key=${encodeURIComponent(key)}&days=${days}`;
    return days === activeDays
      ? `<span class="range-active">${days}d</span>`
      : `<a href="${escapeHtml(href)}">${days}d</a>`;
  }).join(" · ");
  return `<p class="range">Range: ${links}</p>`;
}

export function renderStatusPage(data: StatusData, key: string): string {
  const quotaPct = Math.min(100, Math.round((data.quotaUsedToday / DAILY_QUOTA_CAP) * 100));
  const range = rangePicker(key, data.windowDays);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vera-video-backend status</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid currentColor; opacity: 0.9; padding-bottom: 0.25rem; }
  .tiles { display: flex; flex-wrap: wrap; gap: 1rem; }
  .tile { border: 1px solid currentColor; border-radius: 8px; padding: 0.75rem 1rem; min-width: 140px; }
  .tile .n { font-size: 1.5rem; font-weight: 600; display: block; }
  .tile .label { opacity: 0.7; font-size: 0.8rem; }
  svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid currentColor; }
  .muted { opacity: 0.7; }
  .range { margin-top: 0.5rem; }
  .range a { color: inherit; }
  .range-active { font-weight: 600; text-decoration: underline; }
</style>
</head>
<body>
<h1>vera-video-backend</h1>
<p class="muted">Generated ${escapeHtml(new Date().toISOString())}</p>
${range}

<div class="tiles">
  <div class="tile"><span class="n">${data.activeVideos}</span><span class="label">active videos</span></div>
  <div class="tile"><span class="n">${data.quotaUsedToday} / ${DAILY_QUOTA_CAP}</span><span class="label">YouTube quota today (${quotaPct}%)</span></div>
  <div class="tile"><span class="n">${data.lastUpdated ? escapeHtml(data.lastUpdated) : "—"}</span><span class="label">catalog last updated</span></div>
</div>

<h2>Videos added (last ${data.windowDays} days)</h2>
${sparkline(toPoints(data.videosAddedByDay))}

<h2>Catalog by status</h2>
${barChart(Object.entries(data.videosByStatus).map(([label, value]) => ({ label, value })))}

<h2>YouTube quota used per day (last ${data.windowDays} days)</h2>
${sparkline(toPoints(data.quotaUsedByDay))}

<h2>API traffic (last ${data.windowDays} days)</h2>
${sparkline(toPoints(data.endpointHitsByDay))}

<h2>Endpoint usage (last ${data.windowDays} days)</h2>
${barChart(data.endpointUsage.map((u) => ({ label: u.path, value: u.hits })))}

<h2>Recent crawl errors</h2>
${
  data.recentCrawlErrors.length === 0
    ? `<p class="muted">none in recent history</p>`
    : `<table><thead><tr><th>Started</th><th>Kind</th><th>Error</th></tr></thead><tbody>${data.recentCrawlErrors.map(errorRow).join("")}</tbody></table>`
}
</body>
</html>`;
}
