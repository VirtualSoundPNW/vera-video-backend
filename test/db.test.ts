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
