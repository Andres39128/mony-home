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
- [x] T2: Create migration `0013_enable_rls_public.sql` — 14 `ENABLE ROW LEVEL SECURITY` statements.
- [x] T3: Register migration 0013 in `_journal.json` (idx 13).
- [x] T4: `npm run verify` green (53/53 schema tests).
- [x] T5: Merged `fix/rls-supabase-rls-public` → `main` (merge `9a95b641be23`) and pushed.
- [x] T6: User applied migration 0013 manually in Supabase. Errors dropped 14 → 0, but 15 "RLS Enabled No Policy" suggestions remained (the Postgres default deny satisfies SECURITY but the Advisor wants explicit `CREATE POLICY`).
- [x] T7: Create migration `0014_rls_policies_public.sql` with explicit `app_deny_api` deny policy on each of the 15 tables. Block on `__drizzle_migrations` is wrapped in a `DO $$ ... IF EXISTS (SELECT 1 FROM pg_tables ...) ... END $$` so the migration also runs on PGlite tests (where the PGlite migrator does NOT auto-create `__drizzle_migrations`, unlike the postgres-js migrator used in production).
- [x] T8: Update `src/db/test-utils.ts` to `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;` before applying migrations — PGlite is single-tenant and does not auto-create the Supabase API roles. The test connection itself stays as PGlite superuser, so RLS bypass continues to apply in test code.
- [x] T9: `npm run verify` — 459/459 tests green, lint/typecheck/build clean.
- [x] T10: Register 0014 in `_journal.json` (idx 14). Commit `1d54f681a31b`. Pushed to `origin/main`.
- [ ] T11 (user): Manual apply of 0014 in Supabase SQL Editor + insert hash into `__drizzle_migrations`. Refresh Security Advisor → should drop 15 suggestions → 0.

## Progress / evidence
- Commit chain on `main`: `33fddb767f34` → `d117c8e45c06` → `8872c23f7219` → `9a95b641be23` → `7c170613a863` → `1d54f681a31b`.
- Migration 0013 sha256: `601e354377af3bb54fdd715c86f89303e978adc9d699d6e17c30695f2f974fc9` (already applied).
- Migration 0014 sha256: `b2bf3e1590cf29687ffb996aeb0164e6edd3b952eb1af568882ed722167bc692` (apply next).
- Local + remote: only `main`.

## Next step
T11: paste migration 0014 in Supabase SQL Editor and insert its hash into `__drizzle_migrations`. Refresh Security Advisor.

## Relevant Files
- src/db/migrations/0013_enable_rls_public.sql — new; 14 `ENABLE ROW LEVEL SECURITY`.
- src/db/migrations/0014_rls_policies_public.sql — new; 15 explicit `app_deny_api` policies (one per table, `__drizzle_migrations` block conditional via DO/IF EXISTS).
- src/db/migrations/meta/_journal.json — entries for idx 13 and 14 added.
- src/db/test-utils.ts — creates `anon` and `authenticated` roles before running migrations.
