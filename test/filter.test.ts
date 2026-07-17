import { describe, expect, it } from "vitest";
import { evaluate, normalize, scoreCandidate } from "../src/filter";
import type { Candidate } from "../src/types";

const THRESHOLD = 3;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    videoId: "abc123",
    title: "",
    description: "",
    channelId: "UCtest",
    channelTitle: "",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnailUrl: null,
    tags: [],
    ...overrides,
  };
}

const neutral = { channelPolicy: "neutral" as const, override: null, threshold: THRESHOLD };

describe("normalize", () => {
  it("reduces punctuation so name variants converge", () => {
    expect(normalize("Vera-Project")).toBe("vera project");
    expect(normalize("#VeraProject!!")).toBe("veraproject");
    expect(normalize("The  VERA   Project")).toBe("the vera project");
  });
});

describe("scoreCandidate — keeps genuine Vera Project material", () => {
  it("keeps an exact name match", () => {
    const decision = evaluate(candidate({ title: "Chastity Belt at The Vera Project" }), neutral);
    expect(decision.keep).toBe(true);
  });

  it("keeps a hashtag/handle spelling", () => {
    const decision = evaluate(candidate({ title: "full set", description: "#veraproject" }), neutral);
    expect(decision.keep).toBe(true);
  });

  it("keeps 'live at Vera' with venue context but no full name", () => {
    const decision = evaluate(
      candidate({ title: "Band live at Vera", description: "All ages show in Seattle" }),
      neutral
    );
    expect(decision.keep).toBe(true);
  });

  it("reads signal from tags, not just the title", () => {
    const decision = evaluate(candidate({ title: "full set 2026", tags: ["vera project", "seattle"] }), neutral);
    expect(decision.keep).toBe(true);
  });
});

describe("scoreCandidate — rejects the other Veras", () => {
  const rejects: Array<[string, Partial<Candidate>]> = [
    ["Vera Rubin Observatory", { title: "Vera Rubin Observatory first light images" }],
    ["Vera Wang", { title: "Vera Wang bridal collection 2026" }],
    ["Vera Bradley", { title: "Vera Bradley tote review" }],
    ["the ITV series", { title: "Vera series 14 trailer", description: "Brenda Blethyn returns on ITV" }],
    ["aloe vera", { title: "Aloe vera skincare routine" }],
    ["Veracruz", { title: "Veracruz Mexico travel vlog" }],
    ["Primavera Sound", { title: "Primavera Sound 2026 highlights" }],
    ["the radio-astrometry VERA project", { title: "The VERA project: VLBI radio astrometry explained" }],
    ["a bare mention with no support", { title: "Vera" }],
    ["something unrelated entirely", { title: "How to bake sourdough" }],
  ];

  it.each(rejects)("rejects %s", (_label, fields) => {
    expect(evaluate(candidate(fields), neutral).keep).toBe(false);
  });

  it("lets a decisive disambiguation outweigh a bare name match", () => {
    // "the VERA project" is also a real radio-astronomy program; the VLBI term
    // is what tells them apart.
    const decision = evaluate(candidate({ title: "The VERA Project", description: "VLBI array" }), neutral);
    expect(decision.keep).toBe(false);
  });

  it("scores an unrelated upload well below an on-topic one", () => {
    const onTopic = scoreCandidate(candidate({ title: "Live at The Vera Project, Seattle" }));
    const offTopic = scoreCandidate(candidate({ title: "Vera Rubin and dark matter" }));
    expect(onTopic.score).toBeGreaterThan(offTopic.score);
  });
});

describe("evaluate — precedence", () => {
  it("manual include beats a rejecting score", () => {
    const decision = evaluate(candidate({ title: "Aloe vera" }), { ...neutral, override: "include" });
    expect(decision.keep).toBe(true);
    expect(decision.reason).toMatch(/override/);
  });

  it("manual exclude beats a passing score", () => {
    const decision = evaluate(candidate({ title: "The Vera Project" }), { ...neutral, override: "exclude" });
    expect(decision.keep).toBe(false);
  });

  it("manual exclude beats an allowed channel", () => {
    const decision = evaluate(candidate({ title: "The Vera Project" }), {
      ...neutral,
      channelPolicy: "allow",
      override: "exclude",
    });
    expect(decision.keep).toBe(false);
  });

  it("an allowed channel keeps an upload that would not score on its own", () => {
    const decision = evaluate(candidate({ title: "Untitled clip 004" }), { ...neutral, channelPolicy: "allow" });
    expect(decision.keep).toBe(true);
  });

  it("a blocked channel rejects even an exact name match", () => {
    const decision = evaluate(candidate({ title: "The Vera Project" }), { ...neutral, channelPolicy: "block" });
    expect(decision.keep).toBe(false);
  });
});

describe("threshold is tunable", () => {
  it("a stricter threshold requires the full name, not just context", () => {
    const contextOnly = candidate({ title: "Band live at Vera", description: "All ages, Seattle" });
    expect(evaluate(contextOnly, { ...neutral, threshold: 3 }).keep).toBe(true);
    expect(evaluate(contextOnly, { ...neutral, threshold: 5 }).keep).toBe(false);
  });
});
