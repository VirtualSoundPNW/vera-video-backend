import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/db";

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM channels"),
    env.DB.prepare("DELETE FROM overrides"),
    env.DB.prepare("DELETE FROM sources"),
  ]);
}

function video(id: string, overrides: Partial<db.UpsertVideo> = {}): db.UpsertVideo {
  return {
    videoId: id,
    title: `Video ${id}`,
    description: "desc",
    channelId: "UCvera",
    channelTitle: "Vera",
    publishedAt: "2026-01-01T00:00:00Z",
    durationSeconds: 120,
    thumbnailUrl: "https://img.test/a.jpg",
    tags: [],
    score: 5,
    status: "active",
    ...overrides,
  };
}

async function readVideo(id: string) {
  return env.DB.prepare("SELECT * FROM videos WHERE video_id = ?").bind(id).first<any>();
}

describe("upsertVideos", () => {
  beforeEach(reset);

  it("inserts a new video", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    const row = await readVideo("a");
    expect(row).toMatchObject({ video_id: "a", title: "Video a", status: "active" });
    expect(row.first_seen).toBe("2026-07-01T00:00:00Z");
  });

  it("preserves first_seen across re-crawls", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a")], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).first_seen).toBe("2026-07-01T00:00:00Z");
  });

  it("always advances last_seen", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a")], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).last_seen).toBe("2026-07-09T00:00:00Z");
  });

  // The delta-sync contract: re-crawling unchanged videos must not churn
  // updated_at, or every client would re-download the catalog after each run.
  it("leaves updated_at alone when nothing user-visible changed", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a")], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).updated_at).toBe("2026-07-01T00:00:00Z");
  });

  it("advances updated_at when the title changes", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a", { title: "Retitled" })], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).updated_at).toBe("2026-07-09T00:00:00Z");
  });

  it("advances updated_at when status changes", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a", { status: "rejected" })], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).updated_at).toBe("2026-07-09T00:00:00Z");
  });

  it("advances updated_at when a thumbnail appears", async () => {
    await db.upsertVideos(env.DB, [video("a", { thumbnailUrl: null })], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("a", { thumbnailUrl: "https://img.test/b.jpg" })], "2026-07-09T00:00:00Z");
    expect((await readVideo("a")).updated_at).toBe("2026-07-09T00:00:00Z");
  });
});

describe("markRemoved", () => {
  beforeEach(reset);

  it("flips status and bumps updated_at so clients learn about it", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.markRemoved(env.DB, ["a"], "2026-07-09T00:00:00Z");

    const row = await readVideo("a");
    expect(row.status).toBe("removed");
    expect(row.updated_at).toBe("2026-07-09T00:00:00Z");
  });

  it("does not re-bump updated_at for an already-removed video", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    await db.markRemoved(env.DB, ["a"], "2026-07-09T00:00:00Z");
    await db.markRemoved(env.DB, ["a"], "2026-07-10T00:00:00Z");
    expect((await readVideo("a")).updated_at).toBe("2026-07-09T00:00:00Z");
  });
});

describe("source rotation", () => {
  beforeEach(reset);

  it("prefers a never-crawled source", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'old', '2026-07-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'never', NULL)"),
    ]);
    expect((await db.pickSource(env.DB))!.value).toBe("never");
  });

  it("otherwise picks the least recently crawled", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'stale', '2026-07-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'fresh', '2026-07-09T00:00:00Z')"),
    ]);
    expect((await db.pickSource(env.DB))!.value).toBe("stale");
  });

  it("skips disabled sources", async () => {
    await env.DB.prepare("INSERT INTO sources (kind, value, enabled) VALUES ('search', 'off', 0)").run();
    expect(await db.pickSource(env.DB)).toBeNull();
  });

  it("rotates through every source before repeating", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources (kind, value) VALUES ('search', 'a')"),
      env.DB.prepare("INSERT INTO sources (kind, value) VALUES ('search', 'b')"),
      env.DB.prepare("INSERT INTO sources (kind, value) VALUES ('search', 'c')"),
    ]);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const source = (await db.pickSource(env.DB))!;
      seen.push(source.value);
      // Distinct timestamps: same-millisecond ties would make ordering arbitrary.
      await db.advanceSource(env.DB, source.id, null, `2026-07-0${i + 1}T00:00:00Z`);
    }

    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("autoPromoteChannels", () => {
  beforeEach(reset);

  async function seedChannel(channelId: string, policy = "neutral", title = "Ch") {
    await env.DB.prepare("INSERT INTO channels (channel_id, title, policy, first_seen) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')")
      .bind(channelId, title, policy)
      .run();
  }

  async function seedActiveVideos(channelId: string, count: number, status = "active") {
    const rows = Array.from({ length: count }, (_, i) =>
      video(`${channelId}-v${i}`, { channelId, status: status as db.UpsertVideo["status"] })
    );
    await db.upsertVideos(env.DB, rows, "2026-07-01T00:00:00Z");
  }

  it("adds a channel_uploads source once a channel reaches the threshold", async () => {
    await seedChannel("UCgood", "neutral", "Good Channel");
    await seedActiveVideos("UCgood", 2);

    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(1);

    const row = await env.DB.prepare("SELECT kind, label FROM sources WHERE value = 'UCgood'").first<any>();
    expect(row).toMatchObject({ kind: "channel_uploads", label: "Good Channel uploads (auto)" });
    // Crawl promotion must not touch trust: the filter still applies.
    const channel = await env.DB.prepare("SELECT policy FROM channels WHERE channel_id = 'UCgood'").first<any>();
    expect(channel.policy).toBe("neutral");
  });

  it("only counts active videos, not rejected or removed ones", async () => {
    await seedChannel("UCnoisy");
    await seedActiveVideos("UCnoisy", 1);
    await db.upsertVideos(
      env.DB,
      [video("UCnoisy-r1", { channelId: "UCnoisy", status: "rejected" }), video("UCnoisy-r2", { channelId: "UCnoisy", status: "removed" })],
      "2026-07-01T00:00:00Z"
    );

    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(0);
  });

  it("never promotes a blocked channel", async () => {
    await seedChannel("UCblocked", "block");
    await seedActiveVideos("UCblocked", 5);

    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(0);
  });

  it("skips channels that are already sources, and is safe to re-run", async () => {
    await seedChannel("UCgood");
    await seedActiveVideos("UCgood", 3);

    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(1);
    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(0);

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sources WHERE value = 'UCgood'").first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("skips ids that cannot map to an uploads playlist", async () => {
    await seedChannel("HCweirdid");
    await seedActiveVideos("HCweirdid", 3);

    expect(await db.autoPromoteChannels(env.DB, 2)).toBe(0);
  });
});

describe("pickDueSearchSource", () => {
  beforeEach(reset);

  it("returns the stalest search source past the cutoff, never channel sources", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('channel_uploads', 'UCa', '2019-01-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'older', '2020-01-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'newer', '2021-01-01T00:00:00Z')"),
    ]);

    expect((await db.pickDueSearchSource(env.DB, "2022-01-01T00:00:00Z"))!.value).toBe("older");
  });

  it("returns null when every search source is inside the interval", async () => {
    await env.DB.prepare("INSERT INTO sources (kind, value, last_crawled_at) VALUES ('search', 'fresh', '2026-01-01T00:00:00Z')").run();
    expect(await db.pickDueSearchSource(env.DB, "2025-01-01T00:00:00Z")).toBeNull();
  });

  it("treats never-crawled search sources as due", async () => {
    await env.DB.prepare("INSERT INTO sources (kind, value) VALUES ('search', 'new')").run();
    expect((await db.pickDueSearchSource(env.DB, "2020-01-01T00:00:00Z"))!.value).toBe("new");
  });
});

describe("stalestVideoIds", () => {
  beforeEach(reset);

  it("returns never-checked videos first and ignores removed ones", async () => {
    await db.upsertVideos(env.DB, [video("never"), video("gone", { status: "removed" })], "2026-07-01T00:00:00Z");
    await env.DB.prepare("UPDATE videos SET checked_at = NULL WHERE video_id = 'never'").run();

    expect(await db.stalestVideoIds(env.DB, 10)).toEqual(["never"]);
  });

  it("honors the batch limit", async () => {
    await db.upsertVideos(
      env.DB,
      Array.from({ length: 5 }, (_, i) => video(`v${i}`)),
      "2026-07-01T00:00:00Z"
    );
    expect(await db.stalestVideoIds(env.DB, 2)).toHaveLength(2);
  });
});

describe("channels and overrides", () => {
  beforeEach(reset);

  it("records unseen channels as neutral without clobbering existing policy", async () => {
    await db.recordChannels(env.DB, [{ channelId: "UCa", title: "A" }], "2026-07-01T00:00:00Z");
    await env.DB.prepare("UPDATE channels SET policy='allow' WHERE channel_id='UCa'").run();

    // A later crawl sees the same channel again.
    await db.recordChannels(env.DB, [{ channelId: "UCa", title: "A renamed" }], "2026-07-09T00:00:00Z");

    const policies = await db.channelPolicies(env.DB, ["UCa"]);
    expect(policies.get("UCa")).toBe("allow");
  });

  it("reports neutral for channels it has never seen", async () => {
    const policies = await db.channelPolicies(env.DB, ["UCunknown"]);
    expect(policies.get("UCunknown")).toBeUndefined();
  });

  it("looks up overrides by video id", async () => {
    await env.DB.prepare(
      "INSERT INTO overrides (video_id, action, created_at) VALUES ('x', 'exclude', '2026-07-01T00:00:00Z')"
    ).run();
    const overrides = await db.overridesFor(env.DB, ["x", "y"]);
    expect(overrides.get("x")).toBe("exclude");
    expect(overrides.get("y")).toBeUndefined();
  });
});

describe("knownVideoIds", () => {
  beforeEach(reset);

  it("distinguishes new discoveries from re-crawls", async () => {
    await db.upsertVideos(env.DB, [video("existing")], "2026-07-01T00:00:00Z");
    const known = await db.knownVideoIds(env.DB, ["existing", "brand-new"]);
    expect(known.has("existing")).toBe(true);
    expect(known.has("brand-new")).toBe(false);
  });

  it("handles an empty input without querying", async () => {
    expect(await db.knownVideoIds(env.DB, [])).toEqual(new Set());
  });
});

describe("status page queries", () => {
  beforeEach(async () => {
    await reset();
    await env.DB.batch([env.DB.prepare("DELETE FROM crawl_log"), env.DB.prepare("DELETE FROM endpoint_stats")]);
  });

  it("buckets videos added by day, ignoring rows older than the window", async () => {
    const today = new Date().toISOString();
    await db.upsertVideos(env.DB, [video("recent")], today);
    await env.DB.prepare("UPDATE videos SET first_seen = ? WHERE video_id = 'recent'").bind(today).run();

    await db.upsertVideos(env.DB, [video("ancient")], today);
    await env.DB.prepare("UPDATE videos SET first_seen = '2000-01-01T00:00:00Z' WHERE video_id = 'ancient'").run();

    const rows = await db.videosAddedByDay(env.DB, 30);
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(1);
  });

  it("sums quota used today across multiple crawl runs", async () => {
    const at = new Date().toISOString();
    const a = await db.startCrawl(env.DB, "discovery", null, at);
    await db.finishCrawl(env.DB, a, { apiUnits: 101, fetched: 0, kept: 0, rejected: 0, added: 0 }, at);
    const b = await db.startCrawl(env.DB, "refresh", null, at);
    await db.finishCrawl(env.DB, b, { apiUnits: 50, fetched: 0, kept: 0, rejected: 0, added: 0 }, at);

    expect(await db.quotaUsedToday(env.DB)).toBe(151);
  });

  it("aggregates refresh checks and removals per day, ignoring discovery runs", async () => {
    const at = new Date().toISOString();
    const refresh = await db.startCrawl(env.DB, "refresh", null, at);
    await db.finishCrawl(env.DB, refresh, { apiUnits: 1, fetched: 30, kept: 25, rejected: 3, added: 0, removed: 2 }, at);
    const discovery = await db.startCrawl(env.DB, "discovery", null, at);
    await db.finishCrawl(env.DB, discovery, { apiUnits: 101, fetched: 50, kept: 40, rejected: 10, added: 5 }, at);

    const rows = await db.refreshActivityByDay(env.DB, 30);
    const checked = rows.reduce((sum, r) => sum + r.checked, 0);
    const removed = rows.reduce((sum, r) => sum + r.removed, 0);
    expect(checked).toBe(30);
    expect(removed).toBe(2);
  });

  it("lists only crawls that recorded an error, most recent first", async () => {
    const at = new Date().toISOString();
    const ok = await db.startCrawl(env.DB, "discovery", null, at);
    await db.finishCrawl(env.DB, ok, { apiUnits: 1, fetched: 0, kept: 0, rejected: 0, added: 0 }, at);
    const bad = await db.startCrawl(env.DB, "discovery", null, at);
    await db.finishCrawl(env.DB, bad, { apiUnits: 1, fetched: 0, kept: 0, rejected: 0, added: 0, error: "boom" }, at);

    const errors = (await db.recentCrawlErrors(env.DB, 20)) as { id: number; error: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe("boom");
  });

  it("splits the catalog by status", async () => {
    const at = new Date().toISOString();
    await db.upsertVideos(
      env.DB,
      [video("a", { status: "active" }), video("b", { status: "active" }), video("c", { status: "rejected" })],
      at
    );
    expect(await db.videosByStatus(env.DB)).toEqual({ active: 2, removed: 0, rejected: 1 });
  });

  it("increments hits on repeated calls instead of overwriting the row", async () => {
    await db.recordEndpointHit(env.DB, "2026-07-20", "/catalog", 200);
    await db.recordEndpointHit(env.DB, "2026-07-20", "/catalog", 200);
    await db.recordEndpointHit(env.DB, "2026-07-20", "/catalog", 500);

    const row = await env.DB.prepare("SELECT hits, errors FROM endpoint_stats WHERE day = ? AND path = ?")
      .bind("2026-07-20", "/catalog")
      .first<{ hits: number; errors: number }>();
    expect(row).toEqual({ hits: 3, errors: 1 });
  });

  it("reports per-path usage busiest first", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db.recordEndpointHit(env.DB, today, "/catalog", 200);
    await db.recordEndpointHit(env.DB, today, "/catalog", 200);
    await db.recordEndpointHit(env.DB, today, "/health", 200);

    const usage = await db.endpointUsage(env.DB, 30);
    expect(usage[0]).toMatchObject({ path: "/catalog", hits: 2 });
  });
});
