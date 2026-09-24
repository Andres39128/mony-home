# mony-home

Self-hosted household finance web platform for a single household (2-6 users).

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
