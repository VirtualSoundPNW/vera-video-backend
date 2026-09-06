import { describe, expect, it } from "vitest";
import { isPlayable, parseDuration, uploadsPlaylistId } from "../src/youtube";

describe("parseDuration", () => {
  it.each([
    ["PT3M42S", 222],
    ["PT1H2M3S", 3723],
    ["PT45S", 45],
    ["PT2H", 7200],
    ["P1DT2H", 93600],
    ["PT0S", 0],
  ])("parses %s", (iso, seconds) => {
    expect(parseDuration(iso)).toBe(seconds);
  });

  it("returns null for values it cannot parse rather than guessing", () => {
    expect(parseDuration("garbage")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("uploadsPlaylistId", () => {
  it("derives the uploads playlist from a channel id", () => {
    expect(uploadsPlaylistId("UCabcdefghijklmnopqrstuv")).toBe("UUabcdefghijklmnopqrstuv");
  });

  it("returns null for a non-UC id instead of producing a bogus playlist", () => {
    expect(uploadsPlaylistId("HCabcdef")).toBeNull();
    expect(uploadsPlaylistId("")).toBeNull();
  });
});

describe("isPlayable", () => {
  it("accepts a normal public, embeddable video", () => {
    expect(isPlayable({ privacyStatus: "public", embeddable: true })).toBe(true);
  });

  it("accepts unlisted — it still plays embedded, it just isn't searchable", () => {
    expect(isPlayable({ privacyStatus: "unlisted", embeddable: true })).toBe(true);
  });

  it("rejects private", () => {
    expect(isPlayable({ privacyStatus: "private", embeddable: true })).toBe(false);
  });

  it("rejects embedding disabled", () => {
    expect(isPlayable({ privacyStatus: "public", embeddable: false })).toBe(false);
  });
});
