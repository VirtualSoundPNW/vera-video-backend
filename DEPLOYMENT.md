# Deployment — vera-video-backend

Two parts: a **one-time bootstrap** you do by hand, and **continuous deploys**
from merges to `main`.

The split matters. Bootstrap creates things that must exist exactly once (the
database, the API key) and that CI must never recreate or overwrite. CI only
ships code and schema migrations.

---

## Part 1 — Bootstrap (one time, by hand)

### 1.1 Get a YouTube Data API key

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create
   a project (e.g. `vera-video`).
2. **APIs & Services → Library → YouTube Data API v3 → Enable.**
3. **Credentials → Create credentials → API key.**
4. **Restrict the key → API restrictions → Restrict key → YouTube Data API v3.**

   Leave *Application restrictions* set to **None**. The usual advice is to lock
   a key to an IP range, but Workers egress from Cloudflare's whole edge network
   and has no stable IP, so an IP restriction would break the crawler. The API
   restriction is the meaningful control here; the key's blast radius is
   read-only YouTube metadata against a 10,000 unit/day quota.

5. Note the default quota: **10,000 units/day**. The current schedule spends
   ~400. You do not need a quota increase.

### 1.2 Create the D1 database

```bash
cd vera-video-backend
npm ci
npx wrangler login
npx wrangler d1 create vera-video
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_D1_DATABASE_ID`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "vera-video", "database_id": "<the uuid>", "migrations_dir": "migrations" }
]
```

**Commit this.** A D1 database id is an identifier, not a secret — it is useless
without account credentials, and CI needs it in the repo to deploy.

### 1.3 Apply the schema

```bash
npm run db:migrate:remote     # wrangler d1 migrations apply vera-video --remote
```

Verify:

```bash
npx wrangler d1 execute vera-video --remote --command "SELECT kind, value FROM sources"
```

You should see the four seeded search queries.

### 1.4 Set the secret

```bash
npx wrangler secret put YOUTUBE_API_KEY      # paste the key when prompted
```

Secrets live only in Cloudflare. `wrangler deploy` does **not** touch or clear
them, which is why CI never needs the YouTube key.

### 1.5 First deploy

```bash
npx wrangler deploy
```

This prints the URL, e.g. `https://vera-video-backend.<subdomain>.workers.dev`.
If `workers.dev` is disabled on the account, enable it (**Workers & Pages →
Settings**) or attach a custom route.

### 1.6 Verify

```bash
curl https://vera-video-backend.<subdomain>.workers.dev/health
curl https://vera-video-backend.<subdomain>.workers.dev/catalog   # {"count":0,...} — expected before the first crawl
```

### 1.7 Force the first crawl (don't wait 6 hours)

Cloudflare has no "run cron now" button, and the `/cdn-cgi/handler/scheduled`
trigger endpoint only exists in `wrangler dev`. The trick is to run dev against
**real** bindings:

```bash
npx wrangler dev --remote          # runs on Cloudflare's edge, using the real D1 + secret
# in another shell:
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*/6+*+*+*"
curl "http://localhost:8787/stats"
```

`--remote` means this writes to the production database. Check `/stats`:
`api_units` should be ~101 and `error` null. If `error` shows a 403, the API key
is wrong or the API is not enabled.

Repeat the scheduled call a few times to walk the source rotation (one source
per run), then review what landed:

```bash
npx wrangler d1 execute vera-video --remote --command \
  "SELECT status, COUNT(*) FROM videos GROUP BY status"
```

### 1.8 Tune the filter, then promote the real channel

This is the step that actually needs judgement, and it is why `crawl_log`
exists. Look at what was kept and what was rejected:

```bash
npx wrangler d1 execute vera-video --remote --command \
  "SELECT title, score, status FROM videos ORDER BY score DESC LIMIT 40"
```

Then find The Vera Project's real channel among the ones the crawler recorded,
promote it, and add its uploads as a cheap source (1 unit/page vs 100):

```bash
npx wrangler d1 execute vera-video --remote --command \
  "SELECT channel_id, title FROM channels ORDER BY title"

npx wrangler d1 execute vera-video --remote --command \
  "UPDATE channels SET policy='allow' WHERE channel_id='UC…'"

npx wrangler d1 execute vera-video --remote --command \
  "INSERT INTO sources (kind, value, label) VALUES ('channel_uploads','UC…','Vera uploads')"
```

Expect to iterate on `src/filter.ts` here. The nightly refresh re-applies the
filter to stored rows, so rule changes reach existing videos on their own.

### 1.9 Point the app at it

In `vera-video/gradle.properties`, set `vera.catalog.baseUrl` to the deployed
URL (with trailing slash).

---

## Part 2 — Continuous deploys from GitHub

Goal: merging a PR to `main` on `VirtualSoundPNW/vera-video-backend` runs tests,
applies migrations, and deploys — with no human step.

### 2.1 Create a scoped API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Edit
Cloudflare Workers** (template), then **add one permission**:

| Scope | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit  ← *add this; the template omits it* |
| Account | Account Settings | Read |
| User | User Details | Read |

Limit **Account Resources** to the one account. Don't use a Global API Key —
it is unscoped and cannot be rotated independently.

Also copy your **Account ID** (Workers & Pages → right sidebar).

### 2.2 Add repository secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from 2.1 |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |

`YOUTUBE_API_KEY` is deliberately **not** here — it is already a Worker secret,
and deploys leave it alone.

### 2.3 Add the deploy workflow

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]        # i.e. a merged PR
  workflow_dispatch:         # manual re-run

concurrency:
  group: deploy-production   # never let two deploys race
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      # `wrangler types` reads .dev.vars for secret *names*; CI has no real key
      # and an empty value is enough to generate the Env type.
      - name: Provide placeholder dev vars
        run: cp .dev.vars.example .dev.vars

      # Gate the deploy on the same checks CI runs on the PR.
      - run: npm run typecheck
      - run: npm test

      # Migrations first: new code must never meet an old schema.
      - name: Apply D1 migrations
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: d1 migrations apply vera-video --remote

      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy

      - name: Smoke test
        run: |
          sleep 5
          curl --fail --silent --show-error \
            https://vera-video-backend.<subdomain>.workers.dev/health
```

`cloudflare/wrangler-action@v4` is current and installs Wrangler v4 by default,
matching the local devDependency.

### 2.4 Make the gate real

The workflow above tests before deploying, but nothing stops a direct push to
`main`. In **Settings → Branches → Add branch ruleset** for `main`:

- Require a pull request before merging
- Require status checks to pass → select the existing **CI** job
  (`.github/workflows/ci.yml`, which already runs typecheck + tests on PRs)
- Block force pushes

Optionally, **Settings → Environments → production → Required reviewers** adds a
manual approval between merge and deploy. Worth it once real users depend on the
catalog; overkill before then.

### 2.5 Migration discipline

D1 migrations are **forward-only and not transactional across files**. Because
the app tolerates an older catalog shape (it ignores unknown JSON fields), the
safe pattern is:

1. Additive migration (new nullable column / new table) → deploy.
2. Backfill → deploy code that uses it.
3. Only drop old columns in a later, separate PR.

Never edit a migration that has already been applied — add a new one. Wrangler
tracks applied migrations in a `d1_migrations` table and will not re-run them.

---

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback [<deployment-id>]
```

`rollback` reverts **code only**. It does not undo a migration, which is the
main reason to keep migrations additive.

## Costs

Free tier covers this comfortably: Workers 100k requests/day, D1 5 GB storage
and 5M row reads/day. The catalog is hundreds of rows and a few hundred requests
a day. The YouTube quota (~400 of 10,000 units/day) is the tightest budget, and
only if the discovery cadence or page depth increases.

## Operational checks

| What | How |
|---|---|
| Is the crawler healthy? | `GET /stats` — recent crawls, `api_units`, `error` |
| Is the filter drifting? | `SELECT title, score, status FROM videos ORDER BY updated_at DESC` |
| Worker errors | `npx wrangler tail`, or the Workers → Logs dashboard (observability is enabled in `wrangler.jsonc`) |
