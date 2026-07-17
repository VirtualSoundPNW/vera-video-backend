import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/db";
import type { CatalogResponse } from "../src/types";

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM channels"),
    env.DB.prepare("DELETE FROM overrides"),
    env.DB.prepare("DELETE FROM crawl_log"),
  ]);
}

function video(id: string, overrides: Partial<db.UpsertVideo> = {}): db.UpsertVideo {
  return {
    videoId: id,
    title: `Video ${id}`,
    description: "",
    channelId: "UCvera",
    channelTitle: "Vera",
    publishedAt: "2026-01-01T00:00:00Z",
    durationSeconds: 120,
    thumbnailUrl: null,
    tags: [],
    score: 5,
    status: "active",
    ...overrides,
  };
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await SELF.fetch("https://backend.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("GET /catalog", () => {
  beforeEach(reset);

  it("returns an empty catalog before any crawl", async () => {
    const res = await SELF.fetch("https://backend.test/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.count).toBe(0);
    expect(body.videos).toEqual([]);
    expect(body.delta).toBe(false);
  });

  it("returns active videos newest first, and hides rejected ones", async () => {
    await db.upsertVideos(
      env.DB,
      [
        video("old", { publishedAt: "2025-01-01T00:00:00Z" }),
        video("new", { publishedAt: "2026-06-01T00:00:00Z" }),
        video("junk", { status: "rejected" }),
      ],
      "2026-07-01T00:00:00Z"
    );

    const res = await SELF.fetch("https://backend.test/catalog");
    const body = (await res.json()) as CatalogResponse;

    expect(body.videos.map((v) => v.videoId)).toEqual(["new", "old"]);
    expect(body.count).toBe(2);
  });

  it("round-trips tags as an array", async () => {
    await db.upsertVideos(env.DB, [video("t", { tags: ["seattle", "all ages"] })], "2026-07-01T00:00:00Z");
    const body = (await SELF.fetch("https://backend.test/catalog").then((r) => r.json())) as CatalogResponse;
    expect(body.videos[0]!.tags).toEqual(["seattle", "all ages"]);
  });

  it("serves 304 when the client's ETag still matches", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");

    const first = await SELF.fetch("https://backend.test/catalog");
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await SELF.fetch("https://backend.test/catalog", { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
  });

  it("changes the ETag once the catalog changes", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    const before = (await SELF.fetch("https://backend.test/catalog")).headers.get("ETag");

    await db.upsertVideos(env.DB, [video("b")], "2026-07-02T00:00:00Z");
    const after = (await SELF.fetch("https://backend.test/catalog")).headers.get("ETag");

    expect(after).not.toBe(before);
  });

  it("rejects a malformed since parameter", async () => {
    const res = await SELF.fetch("https://backend.test/catalog?since=yesterday");
    expect(res.status).toBe(400);
  });
});

describe("GET /catalog?since= (delta sync)", () => {
  beforeEach(reset);

  it("returns only rows touched after the cursor", async () => {
    await db.upsertVideos(env.DB, [video("old")], "2026-07-01T00:00:00Z");
    await db.upsertVideos(env.DB, [video("fresh")], "2026-07-05T00:00:00Z");

    const res = await SELF.fetch("https://backend.test/catalog?since=2026-07-03T00:00:00Z");
    const body = (await res.json()) as CatalogResponse;

    expect(body.delta).toBe(true);
    expect(body.videos.map((v) => v.videoId)).toEqual(["fresh"]);
  });

  it("includes removals so clients can prune", async () => {
    await db.upsertVideos(env.DB, [video("gone")], "2026-07-01T00:00:00Z");
    await db.markRemoved(env.DB, ["gone"], "2026-07-05T00:00:00Z");

    const body = (await SELF.fetch("https://backend.test/catalog?since=2026-07-03T00:00:00Z").then((r) =>
      r.json()
    )) as CatalogResponse;

    expect(body.videos).toHaveLength(1);
    expect(body.videos[0]).toMatchObject({ videoId: "gone", status: "removed" });
  });

  it("hands back a cursor that yields an empty delta when nothing changed", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");

    const full = (await SELF.fetch("https://backend.test/catalog").then((r) => r.json())) as CatalogResponse;
    expect(full.cursor).toBeTruthy();

    const delta = (await SELF.fetch(`https://backend.test/catalog?since=${encodeURIComponent(full.cursor!)}`).then((r) =>
      r.json()
    )) as CatalogResponse;

    expect(delta.count).toBe(0);
  });
});

describe("GET /stats", () => {
  beforeEach(reset);

  it("reports catalog size and crawl history", async () => {
    await db.upsertVideos(env.DB, [video("a")], "2026-07-01T00:00:00Z");
    const id = await db.startCrawl(env.DB, "discovery", null, "2026-07-01T00:00:00Z");
    await db.finishCrawl(
      env.DB,
      id,
      { apiUnits: 101, fetched: 50, kept: 4, rejected: 46, added: 4 },
      "2026-07-01T00:00:05Z"
    );

    const body = (await SELF.fetch("https://backend.test/stats").then((r) => r.json())) as any;
    expect(body.activeVideos).toBe(1);
    expect(body.recentCrawls).toHaveLength(1);
    expect(body.recentCrawls[0]).toMatchObject({ api_units: 101, kept: 4, rejected: 46 });
  });
});

describe("unknown routes", () => {
  it("404s as JSON", async () => {
    const res = await SELF.fetch("https://backend.test/nope");
    expect(res.status).toBe(404);
  });
});
