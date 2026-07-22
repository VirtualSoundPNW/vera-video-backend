/**
 * vera-video-backend — HTTP entrypoint and cron dispatch.
 *
 * The read API is intentionally tiny: the Android app syncs the catalog into a
 * local Room database and does all searching there, so this only has to hand
 * over the catalog cheaply and let clients skip unchanged payloads.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as db from "./db";
import { jobForCron, runDiscovery, runRefresh } from "./crawler";
import { gatherStatusData, parseWindowDays, renderStatusPage } from "./status";
import type { CatalogResponse } from "./types";

const app = new Hono<{ Bindings: Env }>();

// The catalog is public, read-only data; allow browsers to read it for
// debugging dashboards. The Android client is unaffected by CORS.
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"] }));

// Aggregate usage per (day, path) for the /status page. A tracking hiccup
// must never fail the real request, hence the swallowed catch.
app.use("/*", async (c, next) => {
  await next();
  try {
    await db.recordEndpointHit(c.env.DB, new Date().toISOString().slice(0, 10), c.req.path, c.res.status);
  } catch (err) {
    console.error("failed to record endpoint stat", err);
  }
});

app.get("/health", (c) => c.json({ ok: true, service: "vera-video-backend" }));

/**
 * GET /catalog          -> full catalog (active videos, newest first)
 * GET /catalog?since=ts -> only rows touched since `ts`, including removals
 *
 * Clients should send back the previous ETag as If-None-Match and, for delta
 * sync, the `cursor` from the last response as `since`.
 */
app.get("/catalog", async (c) => {
  const since = c.req.query("since");

  const meta = await db.catalogMeta(c.env.DB);
  const etag = `W/"${meta.count}-${meta.maxUpdated ?? "empty"}-${since ?? "full"}"`;

  if (c.req.header("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=300" } });
  }

  let videos;
  let delta = false;
  if (since) {
    if (Number.isNaN(Date.parse(since))) {
      return c.json({ error: "`since` must be an ISO 8601 timestamp" }, 400);
    }
    videos = await db.catalogSince(c.env.DB, since);
    delta = true;
  } else {
    videos = await db.fullCatalog(c.env.DB);
  }

  // For a delta, the cursor is the last row's updated_at (rows are ordered by
  // it), so a truncated page resumes exactly where it stopped. For a full
  // catalog it is the global max, so the next delta covers everything since.
  const cursor = delta ? (videos.at(-1)?.updatedAt ?? since ?? null) : meta.maxUpdated;

  const body: CatalogResponse = {
    generatedAt: new Date().toISOString(),
    cursor,
    delta,
    count: videos.length,
    videos,
  };

  return c.json(body, 200, {
    ETag: etag,
    "Cache-Control": "public, max-age=300",
  });
});

/** Crawl history — the tuning surface for the relevance filter and quota use. */
app.get("/stats", async (c) => {
  const [meta, crawls] = await Promise.all([db.catalogMeta(c.env.DB), db.recentCrawls(c.env.DB)]);
  return c.json({ activeVideos: meta.count, lastUpdated: meta.maxUpdated, recentCrawls: crawls });
});

/** Operator dashboard: videos over time, quota burn, errors, endpoint usage. */
app.get("/status", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.STATUS_PAGE_KEY) {
    // 404, not 401/403 — don't confirm to a scanner that this route exists.
    return c.text("not found", 404);
  }

  const windowDays = parseWindowDays(c.req.query("days"));
  const data = await gatherStatusData(c.env.DB, windowDays);
  return c.html(renderStatusPage(data, key), 200, {
    // The URL carries a secret in its query string — must never be cached
    // anywhere the key could leak from (browser or shared/edge cache).
    "Cache-Control": "private, no-store",
  });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((error, c) => {
  console.error("unhandled error", error);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,

  // Cron triggers are at-least-once, so both jobs are written to be safe to
  // re-run: discovery upserts by video_id, refresh only rewrites metadata.
  //
  // Test locally against `wrangler dev` with:
  //   curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/20+*+*+*+*"
  //   curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+3+*+*+*"
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = jobForCron(controller.cron);
    ctx.waitUntil(
      (job === "refresh" ? runRefresh(env) : runDiscovery(env)).then((result) => {
        console.log(`${job} complete`, result);
      })
    );
  },
} satisfies ExportedHandler<Env>;
