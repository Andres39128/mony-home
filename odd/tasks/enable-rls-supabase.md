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
- [ ] T6: Manual apply in Supabase (SQL Editor) — per the `0012` gotcha in `odd/tasks/credito-rotativo.md`, `npm run db:migrate` is a no-op in this network and the Drizzle migrator wraps the file in one transaction that real Postgres rejects for unrelated reasons. Use Supabase SQL Editor (autocommit per statement); then insert the migration hash into `__drizzle_migrations` to keep state consistent.

## Progress / evidence
- T1-T5 done in this session.
- Commit: `d117c8e45c06` on `fix/rls-supabase-rls-public` (3 files, +87 lines).
- Migration sha256: `601e354377af3bb54fdd715c86f89303e978adc9d699d6e17c30695f2f974fc9` (insert into `__drizzle_migrations.hash` after applying).

## Next step
T6: hand the SQL + hash-insert snippet to the user to run in Supabase SQL Editor (production DB out of my reach from this session). Refresh the Supabase Security Advisor after applying — should drop from 14 errors to 0.

## Relevant Files
- src/db/migrations/0013_enable_rls_public.sql — new; 14 `ENABLE ROW LEVEL SECURITY` + rationale comment.
- src/db/migrations/meta/_journal.json — entry for idx 13 added.
- src/db/schema.ts — unchanged; cross-reference for table list.
