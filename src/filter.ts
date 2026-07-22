/**
 * Relevance filtering for the Vera-Video catalog.
 *
 * "Vera" is a heavily overloaded term: the Vera Rubin Observatory, Vera Bradley,
 * Vera Wang, the ITV series `Vera`, aloe vera, and a Japanese radio-astrometry
 * program literally named "the VERA project" all outrank a Seattle all-ages
 * venue on YouTube. So a keyword match alone is not evidence; we score.
 *
 * The Vera Project also operates a second venue, Black Lodge (Eastlake Ave,
 * Seattle — the reopened DIY space formerly known on its own). "Black Lodge"
 * has its own overload problem: Twin Peaks' Black Lodge/Red Room is the
 * dominant sense of the phrase on YouTube, so it gets the same
 * decisive-disambiguation treatment as the various other Veras.
 *
 * Precedence, highest first:
 *   1. manual override        (operator said include/exclude — always wins)
 *   2. channel policy         (allow/block — a known channel needs no scoring)
 *   3. keyword score          (additive, compared against RELEVANCE_THRESHOLD)
 *
 * The scoring weights are a starting point, not truth. `crawl_log` plus the
 * `overrides` table exist so this can be tuned against real results.
 */

import type { Candidate, ChannelPolicy, OverrideAction } from "./types";

export interface FilterContext {
  channelPolicy: ChannelPolicy;
  override: OverrideAction | null;
  threshold: number;
}

export interface Decision {
  keep: boolean;
  score: number;
  /** Short human-readable explanation, surfaced in logs for tuning. */
  reason: string;
}

/** Decisive: either venue's actual name, however it is punctuated or hashtagged. */
const STRONG_POSITIVE = [/\bvera project\b/, /\bveraproject\b/, /\bblack lodge\b/];
const STRONG_POSITIVE_SCORE = 5;

/**
 * Supporting context. Only counted when one of the venue names appears at
 * all, so a generic Seattle show does not drift into the catalog. Capped so
 * that stacking weak signals cannot outweigh a decisive negative.
 */
const CONTEXT_TERMS = [
  /\ball ages\b/,
  /\ballages\b/,
  /\bseattle\b/,
  /\bseattle center\b/,
  /\blive at vera\b/,
  /\bvera stage\b/,
  /\bvera main stage\b/,
  /\bvenue\b/,
  /\bmatinee\b/,
  /\beastlake\b/,
  /\bsouth lake union\b/,
];
const CONTEXT_SCORE = 2;
const CONTEXT_CAP = 4;

/**
 * Decisive disambiguations — each is strong enough on its own to sink a video
 * that would otherwise pass on the phrase match, because these collocations
 * essentially never co-occur with either venue.
 */
const STRONG_NEGATIVE = [
  /\bvera rubin\b/,
  /\brubin observatory\b/,
  /\bvera bradley\b/,
  /\bvera wang\b/,
  /\bvera farmiga\b/,
  /\bvera lynn\b/,
  /\baloe vera\b/,
  /\bvera cruz\b/,
  /\bveracruz\b/,
  /\bprimavera\b/,
  /\bvlbi\b/,
  /\bradio astrometry\b/,
  /\bitv\b/,
  /\bbrenda blethyn\b/,
  // "Black Lodge" collides with Twin Peaks, where it is the dominant sense.
  /\btwin peaks\b/,
  /\bred room\b/,
  /\blaura palmer\b/,
];
const STRONG_NEGATIVE_SCORE = -6;

/** Nothing about either venue — most likely an unrelated upload from an allowed-adjacent channel. */
const NO_MENTION_SCORE = -10;

const VERA = /\bvera\b/;
const BLACK_LODGE = /\bblack lodge\b/;

/**
 * Lowercase and reduce punctuation to spaces so that "Vera-Project",
 * "#VeraProject" and "Vera  Project" all normalize to comparable text.
 * Keeps alphanumerics only; word boundaries then behave predictably.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Text considered for scoring: title, description and tags carry the signal. */
function haystack(candidate: Candidate): string {
  return normalize(
    [candidate.title, candidate.description, candidate.tags.join(" "), candidate.channelTitle].join(" ")
  );
}

export function scoreCandidate(candidate: Candidate): { score: number; reason: string } {
  const text = haystack(candidate);
  const notes: string[] = [];
  let score = 0;

  if (!VERA.test(text) && !/\bveraproject\b/.test(text) && !BLACK_LODGE.test(text)) {
    return { score: NO_MENTION_SCORE, reason: "no mention of vera or black lodge" };
  }

  if (STRONG_POSITIVE.some((re) => re.test(text))) {
    score += STRONG_POSITIVE_SCORE;
    notes.push("name match");
  }

  const contextHits = CONTEXT_TERMS.filter((re) => re.test(text)).length;
  if (contextHits > 0) {
    const contextScore = Math.min(contextHits * CONTEXT_SCORE, CONTEXT_CAP);
    score += contextScore;
    notes.push(`${contextHits} context term(s)`);
  }

  const negativeHits = STRONG_NEGATIVE.filter((re) => re.test(text));
  if (negativeHits.length > 0) {
    score += negativeHits.length * STRONG_NEGATIVE_SCORE;
    notes.push(`${negativeHits.length} disambiguation(s)`);
  }

  return { score, reason: notes.length > 0 ? notes.join(", ") : "vera mentioned, no supporting signal" };
}

export function evaluate(candidate: Candidate, ctx: FilterContext): Decision {
  if (ctx.override === "include") return { keep: true, score: 100, reason: "manual override: include" };
  if (ctx.override === "exclude") return { keep: false, score: -100, reason: "manual override: exclude" };
  if (ctx.channelPolicy === "block") return { keep: false, score: -100, reason: "channel blocked" };
  if (ctx.channelPolicy === "allow") return { keep: true, score: 100, reason: "channel allowed" };

  const { score, reason } = scoreCandidate(candidate);
  return { keep: score >= ctx.threshold, score, reason };
}
