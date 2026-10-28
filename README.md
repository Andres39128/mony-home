# mony-home

Self-hosted household finance web platform for a single household (2-6 users).

Track categories, budgets, recurring transactions and credit-card cycles, with
row-level security so each member only sees their own data. Ships with an
LLM assistant that answers questions about your spending against a daily quota.

**Stack:** Next.js · TypeScript · PostgreSQL (Supabase) · Drizzle ORM · Tailwind · zod

## What it does

- **Budgets by category** — monthly limits per category with progress tracking
- **Recurring transactions** — catch-up logic handles missed cycles without double-counting
- **Credit card cycles** — purchases, limits and closing dates tracked separately from cash
- **Multi-currency** — balances and transactions can carry their own currency
- **Audit trail** — every mutation is recorded, not just the current state
- **LLM assistant** — OpenAI-compatible endpoint (default OpenRouter), per-user daily quota
- **Self-hosted** — your financial data lives in your own Postgres, behind RLS

## Setup

```bash
cp .env.example .env.local
npm install
```

## Commands

```bash
npm run dev        # start the dev server
npm run verify     # lint + typecheck + test + build (must pass before every push)
```

## Configuration

All runtime configuration is environment-driven and validated with zod in
`src/lib/config.ts`. See `.env.example` for every variable and its purpose.
Config parsing is lazy: the build never requires optional variables, but using
the config with an invalid state throws an error naming the offending variable.

## Operations (production)

### Deploy

1. Import the repo in Vercel (or run `vercel link` + `vercel git connect`
   locally) — every push to `main` deploys.
2. Set the required runtime environment variables in the Vercel project:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase **Transaction pooler** URL (port `6543`) |
   | `LLM_BASE_URL` | OpenAI-compatible endpoint (default `https://openrouter.ai/api/v1`) |
   | `LLM_API_KEY` | OpenRouter API key |
   | `LLM_MODEL` | Model id, e.g. `openrouter/free` |
   | `ASSISTANT_DAILY_LIMIT` | Per-user daily quota (default `8`) |
   | `APP_NAME` | App name, also sent to OpenRouter as attribution |
   | `SENTRY_DSN` | *Optional.* Server-side Sentry DSN — empty = error reporting disabled |
   | `NEXT_PUBLIC_SENTRY_DSN` | *Optional.* Browser-side Sentry DSN — empty = error reporting disabled (must be set at build time) |

   `DIRECT_URL` (port `5432`) is only needed locally/CI for migrations —
   Vercel never runs migrations, so it does not need it.

### Database

1. Create the Supabase project and copy both connection strings:
   - **Transaction pooler** URL (port `6543`) → `DATABASE_URL` (app + Vercel).
   - **Session/direct** URL (port `5432`) → `DIRECT_URL` (migrations).
2. Apply the schema: `npm run db:migrate` (uses `DIRECT_URL` from `.env.local`).
3. Bootstrap production data: `SEED_DEMO_DATA=false SEED_ALLOW_PROD=yes
   SEED_ADMIN_PASSWORD=<real-password> npm run db:seed` — inserts the 13
   categories and the single `admin` user only. Seeding refuses to run in
   production without `SEED_ALLOW_PROD=yes`, and `SEED_ADMIN_PASSWORD` has no
   default anymore (the old changeme placeholder is rejected). Idempotent;
   re-running is safe.

### Backups

The `backup` workflow (`.github/workflows/backup.yml`) dumps the database
every Monday 04:00 UTC (and on manual dispatch) via `pg_dump`, gzips it and
uploads it as a workflow artifact retained for **90 days**.

1. One-time setup — give GitHub the direct (port `5432`) connection string,
   NOT the transaction pooler (`6543` breaks `pg_dump`):
   ```bash
   gh secret set SUPABASE_DB_URL
   ```
2. Restore:
   - Download the `db-backup-YYYY-MM-DD` artifact from the workflow run and
     unzip it.
   - `gunzip backup-YYYY-MM-DD.sql.gz`
   - `psql "$SUPABASE_DB_URL" -f backup-YYYY-MM-DD.sql`

   The dump is plain-text SQL (schema + data). Restoring into a **non-empty**
   database fails with `already exists` errors — the supported procedure is
   restoring into a **fresh/empty** database. If you must restore over an
   existing one, drop the schema first and accept that everything currently
   in it is destroyed:
   ```bash
   psql "$SUPABASE_DB_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
   psql "$SUPABASE_DB_URL" -f backup-YYYY-MM-DD.sql
   ```

### Rollback

Vercel keeps every production deployment, so reverting the **code** is
instant: Dashboard → Deployments → previous deployment → **Promote**, or
`vercel rollback` from a linked checkout.

**Rolling back the deploy does NOT roll back the database.** Migrations run
manually (`npm run db:migrate` against `DIRECT_URL`) and are never executed
by Vercel, so promoting an older deployment leaves the schema at the newest
migration. Before rolling back:

1. Check whether a migration shipped between the two deployments. Older code
   querying renamed/dropped columns breaks against the newer schema — if the
   migration is backward-compatible, the rollback is safe.
2. If a migration itself is the cause of the incident, falling back to the
   restore procedure in [Backups](#backups) (into a fresh database) is the
   escape hatch — note it discards everything written after that backup.

### Monitoring

**Health endpoint.** `GET /api/health` is public (no login) and checks the
database: `200 {"status":"ok"}` means app + database reachable;
`503 {"status":"unavailable"}` means the database is down. Point an uptime
monitor's HTTP check at `https://<your-domain>/api/health` to catch outages
between backups.

**Backup dead-man switch.** The `backup` and `backup-verify` workflows ping a
heartbeat URL **only when they succeed** — a failed *or never-run* workflow
stays silent and the monitor alerts after its grace period. To wire it:

1. Create a heartbeat-type check in your uptime monitor (e.g. healthchecks.io)
   and copy its ping URL.
2. Store it as the `HEARTBEAT_URL` GitHub secret (unset = heartbeat disabled):
   ```bash
   gh secret set HEARTBEAT_URL
   ```
3. Set the check's grace period above the workflow cadences (e.g. 1 day, so
   both the weekly backup and the monthly drill fit inside it).

**Monthly restore drill.** The `backup-verify` workflow (1st of each month,
06:30 UTC, also on manual dispatch) downloads the newest backup artifact and
replays it into a throwaway in-memory database, asserting the core tables
hold data — proving backups restore, not just exist. Artifacts expire after
90 days, so the monthly cadence stays inside the retention window.

**Alert test** (run once after wiring the heartbeat):

1. Force one failure: temporarily break `SUPABASE_DB_URL` (or unset it) and
   dispatch `backup` manually — no ping is sent, so the monitor must alert
   once its grace period elapses.
2. Force one success: restore the secret and dispatch `backup` again — the
   monitor must show the ping received (which clears the alert).
3. Clean up: delete the failed run's artifacts (if any) and reset the check.

### Assistant model swap

1. Change `LLM_MODEL` in the Vercel project env and in your local
   `.env.local`, then redeploy/restart.
2. Before committing to a model, re-rank the free-tier candidates against a
   local throwaway database (full procedure in the header of
   `scripts/assistant-eval.ts`):
   ```bash
   podman run -d --name mony-eval-pg -e POSTGRES_PASSWORD=eval -p 55432:5432 postgres:17-alpine
   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres \
   DIRECT_URL=postgresql://postgres:eval@localhost:55432/postgres npm run db:migrate
   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres npm run db:seed
   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres \
     node --env-file-if-exists=.env.local --import ./scripts/alias-loader.mjs scripts/assistant-eval.ts
   podman rm -f mony-eval-pg
   ```

### Troubleshooting

- **Pooled vs direct confusion.** The app talks to the **Transaction pooler**
  (port `6543`); migrations use the **direct/session** connection (port
  `5432`). Swapping them causes hangs or errors — check the port in the URL.
- **`too many connections`.** The app is pointing `DATABASE_URL` at the
  direct connection instead of the pooler. Fix the port/URL in Vercel.
- **`pg_dump` fails or hangs in the backup workflow.** `SUPABASE_DB_URL` is
  set to the transaction pooler (`6543`). It must be the session/direct
  (`5432`) URL.

## License

MIT — see [`LICENSE`](LICENSE).
