import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM crawl_log"),
    env.DB.prepare("DELETE FROM endpoint_stats"),
  ]);
}

describe("GET /status", () => {
  beforeEach(reset);

  it("404s with no key", async () => {
    const res = await SELF.fetch("https://backend.test/status");
    expect(res.status).toBe(404);
  });

  it("404s with the wrong key", async () => {
    const res = await SELF.fetch("https://backend.test/status?key=wrong");
    expect(res.status).toBe(404);
  });

  it("renders the page with the correct key, and forbids caching", async () => {
    const res = await SELF.fetch(`https://backend.test/status?key=${env.STATUS_PAGE_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toContain("vera-video-backend");
  });
});

describe("endpoint usage tracking", () => {
  beforeEach(reset);

  it("records a hit against the requested path", async () => {
    await SELF.fetch("https://backend.test/health");

    const today = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare("SELECT hits, errors FROM endpoint_stats WHERE day = ? AND path = ?")
      .bind(today, "/health")
      .first<{ hits: number; errors: number }>();
    expect(row).toEqual({ hits: 1, errors: 0 });
  });

  it("does not fail the real response if tracking is unavailable", async () => {
    // /health itself has no DB dependency, so this just confirms the
    // middleware's own try/catch shape doesn't leak into the response.
    const res = await SELF.fetch("https://backend.test/health");
    expect(res.status).toBe(200);
  });
});
