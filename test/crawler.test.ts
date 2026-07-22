import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDiscovery, runRefresh, jobForCron } from "../src/crawler";

/**
 * The crawler is exercised end-to-end against a stubbed YouTube. Global fetch
 * is stubbed rather than the client module, so URL construction, quota
 * accounting, parsing, scoring and persistence are all really executed.
 */

interface StubVideo {
  id: string;
  title?: string;
  description?: string;
  channelId?: string;
  channelTitle?: string;
  duration?: string;
}

/** Build a videos.list item as the API would return it. */
function videoItem(v: StubVideo) {
  return {
    id: v.id,
    snippet: {
      title: v.title ?? `Video ${v.id}`,
      description: v.description ?? "",
      channelId: v.channelId ?? "UCsomechannel",
      channelTitle: v.channelTitle ?? "Some Channel",
      publishedAt: "2026-05-01T00:00:00Z",
      thumbnails: { high: { url: `https://i.ytimg.com/${v.id}.jpg` } },
      tags: [],
    },
    contentDetails: { duration: v.duration ?? "PT3M0S" },
  };
}

interface StubOptions {
  searchIds?: string[];
  nextPageToken?: string | null;
  videos?: StubVideo[];
  failSearch?: boolean;
}

const calls: string[] = [];

function stubYouTube(opts: StubOptions) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);

      if (url.pathname.endsWith("/search")) {
        if (opts.failSearch) return new Response("quota exceeded", { status: 403 });
        return Response.json({
          items: (opts.searchIds ?? []).map((id) => ({ id: { videoId: id } })),
          nextPageToken: opts.nextPageToken ?? undefined,
        });
      }

      if (url.pathname.endsWith("/playlistItems")) {
        return Response.json({
          items: (opts.searchIds ?? []).map((id) => ({ contentDetails: { videoId: id } })),
          nextPageToken: opts.nextPageToken ?? undefined,
        });
      }

      if (url.pathname.endsWith("/videos")) {
        const requested = new Set((url.searchParams.get("id") ?? "").split(","));
        return Response.json({
          items: (opts.videos ?? []).filter((v) => requested.has(v.id)).map(videoItem),
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

async function seedSearchSource(query = "vera project") {
  await env.DB.prepare("INSERT INTO sources (kind, value, label) VALUES ('search', ?, 'test')").bind(query).run();
  return env.DB.prepare("SELECT id FROM sources WHERE value = ?").bind(query).first<{ id: number }>();
}

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM channels"),
    env.DB.prepare("DELETE FROM overrides"),
    env.DB.prepare("DELETE FROM sources"),
    env.DB.prepare("DELETE FROM crawl_log"),
  ]);
  calls.length = 0;
}

beforeEach(reset);
afterEach(() => vi.unstubAllGlobals());

describe("runDiscovery", () => {
  it("stores on-topic videos as active and off-topic ones as rejected", async () => {
    await seedSearchSource();
    stubYouTube({
      searchIds: ["keep1", "drop1"],
      videos: [
        { id: "keep1", title: "Band live at The Vera Project" },
        { id: "drop1", title: "Vera Rubin Observatory tour" },
      ],
    });

    const result = await runDiscovery(env);

    expect(result.kept).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.added).toBe(2);

    const rows = await env.DB.prepare("SELECT video_id, status FROM videos ORDER BY video_id").all<any>();
    expect(rows.results).toEqual([
      { video_id: "drop1", status: "rejected" },
      { video_id: "keep1", status: "active" },
    ]);
  });

  it("hydrates search hits via videos.list rather than trusting search snippets", async () => {
    await seedSearchSource();
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project", duration: "PT1H2M3S" }] });

    await runDiscovery(env);

    expect(calls).toEqual(["/youtube/v3/search", "/youtube/v3/videos"]);
    const row = await env.DB.prepare("SELECT duration_seconds, thumbnail_url FROM videos WHERE video_id='v1'").first<any>();
    expect(row.duration_seconds).toBe(3723);
    expect(row.thumbnail_url).toBe("https://i.ytimg.com/v1.jpg");
  });

  it("accounts for quota: 100 for search plus 1 for hydration", async () => {
    await seedSearchSource();
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project" }] });

    const result = await runDiscovery(env);

    expect(result.apiUnits).toBe(101);
    const log = await env.DB.prepare("SELECT kind, api_units, error FROM crawl_log").first<any>();
    expect(log).toMatchObject({ kind: "discovery", api_units: 101, error: null });
  });

  it("spends no hydration quota when a page returns nothing", async () => {
    await seedSearchSource();
    stubYouTube({ searchIds: [] });

    const result = await runDiscovery(env);

    expect(result.apiUnits).toBe(100);
    expect(calls).toEqual(["/youtube/v3/search"]);
  });

  it("saves the page token so the next run resumes", async () => {
    const source = await seedSearchSource();
    stubYouTube({ searchIds: ["v1"], nextPageToken: "PAGE2", videos: [{ id: "v1", title: "The Vera Project" }] });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT page_token, last_crawled_at FROM sources WHERE id = ?")
      .bind(source!.id)
      .first<any>();
    expect(row.page_token).toBe("PAGE2");
    expect(row.last_crawled_at).toBeTruthy();
  });

  it("clears the page token at the end of a source so it restarts and finds new uploads", async () => {
    const source = await seedSearchSource();
    await env.DB.prepare("UPDATE sources SET page_token = 'PAGE9' WHERE id = ?").bind(source!.id).run();
    stubYouTube({ searchIds: ["v1"], nextPageToken: null, videos: [{ id: "v1", title: "The Vera Project" }] });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT page_token FROM sources WHERE id = ?").bind(source!.id).first<any>();
    expect(row.page_token).toBeNull();
  });

  it("records encountered channels as neutral for later review", async () => {
    await seedSearchSource();
    stubYouTube({
      searchIds: ["v1"],
      videos: [{ id: "v1", title: "The Vera Project", channelId: "UCvera", channelTitle: "The Vera Project" }],
    });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT title, policy FROM channels WHERE channel_id='UCvera'").first<any>();
    expect(row).toMatchObject({ title: "The Vera Project", policy: "neutral" });
  });

  it("honors an allowed channel for an upload that would not score on its own", async () => {
    await seedSearchSource();
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, title, policy, first_seen) VALUES ('UCvera', 'Vera', 'allow', '2026-01-01T00:00:00Z')"
    ).run();
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "Untitled clip 004", channelId: "UCvera" }] });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT status FROM videos WHERE video_id='v1'").first<any>();
    expect(row.status).toBe("active");
  });

  it("counts re-crawled videos as seen but not newly added", async () => {
    await seedSearchSource();
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project" }] });

    await runDiscovery(env);
    await env.DB.prepare("UPDATE sources SET last_crawled_at = NULL").run();
    const second = await runDiscovery(env);

    expect(second.added).toBe(0);
    expect(second.kept).toBe(1);
  });

  it("uses the cheap playlist endpoint for channel sources", async () => {
    await env.DB.prepare(
      "INSERT INTO sources (kind, value, label) VALUES ('channel_uploads', 'UCabcdefghijklmnopqrstuv', 'uploads')"
    ).run();
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project" }] });

    // A channel source alone costs 2 units, well under the default 100-unit
    // target, so a low target isolates this to exactly one source-pass.
    const result = await runDiscovery({ ...env, DISCOVERY_QUOTA_TARGET: "1" } as unknown as Env);

    expect(calls[0]).toBe("/youtube/v3/playlistItems");
    expect(result.apiUnits).toBe(2); // 1 for the playlist page + 1 for hydration
  });

  it("does nothing when there are no sources", async () => {
    stubYouTube({});
    const result = await runDiscovery(env);
    expect(result).toMatchObject({ apiUnits: 0, fetched: 0 });
    expect(calls).toEqual([]);
  });
});

describe("runDiscovery — spends up to the quota target in one run", () => {
  async function seedChannelSource(value: string) {
    await env.DB.prepare("INSERT INTO sources (kind, value, label) VALUES ('channel_uploads', ?, 'test')")
      .bind(value)
      .run();
  }

  it("keeps crawling additional sources until the target is reached", async () => {
    await seedChannelSource("UCaaaaaaaaaaaaaaaaaaaaaa");
    await seedChannelSource("UCbbbbbbbbbbbbbbbbbbbbbb");
    await seedChannelSource("UCcccccccccccccccccccccc");
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project" }] });

    // 2 units/source (channel_uploads): 2, 4, 6 — needs all 3 to clear a
    // target of 5, since each source alone leaves it unmet.
    const result = await runDiscovery({ ...env, DISCOVERY_QUOTA_TARGET: "5" } as unknown as Env);

    expect(result.apiUnits).toBe(6);
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM crawl_log").first<{ n: number }>();
    expect(log!.n).toBe(3); // one crawl_log row per source, not one for the whole run
  });

  it("stops at the per-invocation source cap even if the target isn't met", async () => {
    await seedChannelSource("UCaaaaaaaaaaaaaaaaaaaaaa");
    stubYouTube({ searchIds: ["v1"], videos: [{ id: "v1", title: "The Vera Project" }] });

    // A single cheap source, revisited repeatedly, would burn quota forever
    // trying to reach the (much higher) default target — the safety cap
    // must cut it off well before that.
    const result = await runDiscovery(env);

    expect(result.apiUnits).toBe(8); // 4 sources (the cap) x 2 units
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM crawl_log").first<{ n: number }>();
    expect(log!.n).toBe(4);
  });
});

describe("runDiscovery — failure handling", () => {
  it("logs the error instead of throwing", async () => {
    await seedSearchSource();
    stubYouTube({ failSearch: true });

    const result = await runDiscovery(env);

    expect(result.error).toMatch(/403/);
    const log = await env.DB.prepare("SELECT error, finished_at FROM crawl_log").first<any>();
    expect(log.error).toMatch(/403/);
    expect(log.finished_at).toBeTruthy();
  });

  // YouTube bills the request, not the response, so a failed search still costs
  // 100 units. Recording 0 would make the log understate real quota burn.
  it("still charges quota for a failed call", async () => {
    await seedSearchSource();
    stubYouTube({ failSearch: true });

    const result = await runDiscovery(env);

    expect(result.apiUnits).toBe(100);
    const log = await env.DB.prepare("SELECT api_units FROM crawl_log").first<any>();
    expect(log.api_units).toBe(100);
  });

  // A source that always errors must not sit at the head of the rotation
  // forever and starve every other source.
  it("still advances the rotation so one broken source cannot wedge it", async () => {
    const source = await seedSearchSource();
    stubYouTube({ failSearch: true });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT last_crawled_at FROM sources WHERE id = ?").bind(source!.id).first<any>();
    expect(row.last_crawled_at).toBeTruthy();
  });

  it("preserves the page token on failure so no page is skipped", async () => {
    const source = await seedSearchSource();
    await env.DB.prepare("UPDATE sources SET page_token = 'PAGE5' WHERE id = ?").bind(source!.id).run();
    stubYouTube({ failSearch: true });

    await runDiscovery(env);

    const row = await env.DB.prepare("SELECT page_token FROM sources WHERE id = ?").bind(source!.id).first<any>();
    expect(row.page_token).toBe("PAGE5");
  });
});

describe("runRefresh", () => {
  async function seedActive(id: string, title = "The Vera Project set") {
    await env.DB.prepare(
      `INSERT INTO videos (video_id, title, description, channel_id, channel_title, published_at,
         duration_seconds, thumbnail_url, tags, score, status, first_seen, last_seen, updated_at, checked_at)
       VALUES (?, ?, '', 'UCvera', 'Vera', '2026-01-01T00:00:00Z', 60, NULL, '[]', 5, 'active',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)`
    )
      .bind(id, title)
      .run();
  }

  it("marks videos YouTube no longer returns as removed", async () => {
    await seedActive("gone");
    stubYouTube({ videos: [] }); // videos.list returns nothing for it

    const result = await runRefresh(env);

    expect(result.apiUnits).toBe(1);
    const row = await env.DB.prepare("SELECT status FROM videos WHERE video_id='gone'").first<any>();
    expect(row.status).toBe("removed");
  });

  it("refreshes metadata for videos that still exist", async () => {
    await seedActive("v1", "Old title");
    stubYouTube({ videos: [{ id: "v1", title: "The Vera Project — remastered", duration: "PT10M" }] });

    await runRefresh(env);

    const row = await env.DB.prepare("SELECT title, duration_seconds, checked_at FROM videos WHERE video_id='v1'").first<any>();
    expect(row.title).toBe("The Vera Project — remastered");
    expect(row.duration_seconds).toBe(600);
    expect(row.checked_at).toBeTruthy();
  });

  // Retuning the filter (or adding an override) has to be able to retire rows
  // that were accepted under the old rules.
  it("re-applies the filter, retiring a video that no longer qualifies", async () => {
    await seedActive("v1");
    stubYouTube({ videos: [{ id: "v1", title: "Vera Rubin Observatory tour" }] });

    await runRefresh(env);

    const row = await env.DB.prepare("SELECT status FROM videos WHERE video_id='v1'").first<any>();
    expect(row.status).toBe("rejected");
  });

  it("applies a manual include added after the fact", async () => {
    await seedActive("v1");
    await env.DB.prepare(
      "INSERT INTO overrides (video_id, action, created_at) VALUES ('v1', 'exclude', '2026-01-01T00:00:00Z')"
    ).run();
    stubYouTube({ videos: [{ id: "v1", title: "The Vera Project" }] });

    await runRefresh(env);

    const row = await env.DB.prepare("SELECT status FROM videos WHERE video_id='v1'").first<any>();
    expect(row.status).toBe("rejected");
  });

  it("skips the API entirely when there is nothing to refresh", async () => {
    stubYouTube({ videos: [] });
    const result = await runRefresh(env);
    expect(result.apiUnits).toBe(0);
    expect(calls).toEqual([]);
  });

  it("logs failures rather than throwing", async () => {
    await seedActive("v1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    const result = await runRefresh(env);

    expect(result.error).toMatch(/500/);
  });
});

describe("jobForCron", () => {
  it("routes the nightly schedule to refresh and everything else to discovery", () => {
    expect(jobForCron("45 3 * * *")).toBe("refresh");
    expect(jobForCron("0 * * * *")).toBe("discovery");
  });
});
