/**
 * `Env` itself is ambient: `wrangler types` generates it from the bindings in
 * wrangler.jsonc plus the keys in .dev.vars, so it is not declared by hand
 * here. Run `npm run cf-typegen` after changing either.
 */

/** Vars arrive as strings; parse once with defensive defaults and API caps. */
export function config(env: Env) {
  return {
    refreshBatchSize: clamp(int(env.REFRESH_BATCH_SIZE, 50), 1, 50),
    discoveryPageSize: clamp(int(env.DISCOVERY_PAGE_SIZE, 50), 1, 50),
    relevanceThreshold: int(env.RELEVANCE_THRESHOLD, 3),
  };
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
