import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker, against the isolated per-run D1 instance.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
