# Feature: Enable RLS on public schema (Supabase Security Advisor)

## Objective
Resolve the 14 "RLS Disabled in Public" errors in the Supabase Security Advisor by enabling Row Level Security on every public-schema table. Defends the data layer against anonymous PostgREST access; leaves the app's direct Postgres connection unaffected (superuser bypass).

## Problem / Why
Supabase exposes the `public` schema via PostgREST at `https://<ref>.supabase.co/rest/v1/`. Without RLS, any caller holding the project's `anon` key can SELECT/INSERT/UPDATE/DELETE every row. The app never uses PostgREST (it talks to Postgres directly via postgres.js through the Supavisor SESSION pooler, port 5432, with the `postgres` role), but the attack surface is open until RLS is enabled.

## Scope
- Add migration `0013_enable_rls_public.sql` that runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on every public table (14, matching `src/db/schema.ts` and the Security Advisor screenshot).
- Register the migration in `src/db/migrations/meta/_journal.json` so `npm run db:migrate` picks it up on future runs.
- No schema.ts changes — RLS is a Postgres feature, not part of the Drizzle schema model. No Drizzle `pgPolicy` either: the Postgres default ("RLS on, no policies = deny") is exactly what we want for anon/authenticated, and the app role bypasses RLS by being superuser, so no permissive policies are needed.
- No `FORCE ROW LEVEL SECURITY`: would make even the table owner subject to policies, which we don't want (the direct-connection role may be the owner).

## Authorized scope / constraints
- Repo: mony-home, branch `fix/rls-supabase-rls-public` (cut from `feat/transactions-opening-balance`).
- Per user rules: no hardcoded constants outside config, no duplication, no orphan code, hygienic close (lint + typecheck + tests + build).
- Artifacts (SQL, code comments, commit) in English; conversational reply in Spanish rioplatense.

## TDD mode
Off (per repo config; tests run with vitest + PGlite after each change).

## Delivery strategy
ask-on-risk (default). This is a single-file migration + journal entry (~50 lines added, ~0 lines removed). Forecast ≪ 400 — single PR, no chain needed.

## Tasks
- [x] T1: Cut branch `fix/rls-supabase-rls-public` from current feature.
- [x] T2: Create migration `src/db/migrations/0013_enable_rls_public.sql` with 14 `ENABLE ROW LEVEL SECURITY` statements + header comment explaining the rationale.
- [x] T3: Register migration 0013 in `src/db/migrations/meta/_journal.json` (idx 13, timestamp via `Date.now()`).
- [x] T4: Run `npm run verify` — 53/53 schema tests pass, lint/typecheck/build green.
- [x] T5: Work-unit commit `d117c8e45c06` on the feature branch.
- [x] T6: Merged `fix/rls-supabase-rls-public` into `main` via `--no-ff` (merge commit `9a95b641be23`). NOTE: the branch was cut from `feat/transactions-opening-balance`, so the merge also pulled in `33fddb767f34 feat(transactions): opening balance carried across months` — that commit is now in main too. User accepted ("todo lo podemos hacer en main").
- [x] T7: Pushed `main` to `origin/main` (`f244276d38b9..9a95b641be23`).
- [x] T8: Deleted local branches: `fix/rls-supabase-rls-public`, `feat/transactions-opening-balance`, `security/csp-style-split-hsts-preload`, `feat/credito-rotativo`. Repo is now just `main` locally.
- [ ] T9 (user): Manual apply in Supabase production DB — paste `0013_enable_rls_public.sql` into SQL Editor (autocommit) and insert hash into `__drizzle_migrations`. Refresh Security Advisor → should drop 14 → 0.

## Progress / evidence
- Commits on `main` since this session: `33fddb767f34` (opening-balance), `d117c8e45c06` (RLS migration), `8872c23f7219` (RLS docs), `9a95b641be23` (merge commit).
- Migration sha256: `601e354377af3bb54fdd715c86f89303e978adc9d699d6e17c30695f2f974fc9` (insert into `__drizzle_migrations.hash` after applying).
- `npm run verify` green at the time of merge.

## Next step
T9: user applies migration manually in Supabase SQL Editor and refreshes the Security Advisor.

## Relevant Files
- src/db/migrations/0013_enable_rls_public.sql — new; 14 `ENABLE ROW LEVEL SECURITY` + rationale comment.
- src/db/migrations/meta/_journal.json — entry for idx 13 added.
- src/db/schema.ts — unchanged; cross-reference for table list.
