# Feature: Production Readiness (PRR fixes)

## Objective

Close the two blockers and the conditions from the 2026-10-12 Production Readiness Review:
silent backup failure and zero failure detection, plus rollback/runbook docs.

## Problem

The app can fail and nobody notices for days: the weekly pg_dump workflow fails silently,
there is no health endpoint, no uptime monitor target, no error reporting (client errors are
bare `console.error`), and the restore drill (`scripts/verify-backup.mjs`) is not wired to CI.

## Why

Single-operator household finance PWA in production (Vercel + Supabase). Data loss without
notification is the worst-case scenario; detection is the gap, not code quality.

## Scope

Authorized: health endpoint + proxy matcher exclusion, optional Sentry wiring (no-op without
DSN), GitHub Actions backup heartbeat + monthly backup-verify workflow, README rollback and
monitoring docs, `.env.example` additions.
Out of scope: metrics/tracing, request correlation IDs, staging environment, load testing.

## Constraints

- Sentry must be a strict no-op until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set
  (repo convention: no new runtime deps until configured — this task adds it now).
- `@sentry/nextjs` 11.7.0 supports `next ^16.0.0-0`.
- Health endpoint is public (uptime-monitor target): no auth, no info leak beyond ok/unavailable.
- Next 16: verify file conventions against `node_modules/next/dist/docs/` before relying on
  them (proxy.ts / instrumentation-client.ts).
- User WIP stashed: `git stash pop` after this feature lands; keep hunks conflict-free.

## Tasks

- [x] T1: `GET /api/health` route (DB ping, 200/503, no-store) + `/api/health` exclusion in
  `src/proxy.ts` matcher + vitest tests (TDD: RED → GREEN observed). Route: delegated direct.
- [x] T2: Optional Sentry: `@sentry/nextjs@11.7.0`, guarded `register()`, CSP connect-src
  from DSN origin (byte-identical without DSN), capture in error boundaries, JSON console
  line unchanged. Deviations: `sendDefaultPii` absent in 11.7.0 (omitted, off by default);
  `execute("select 1")` plain string (eslint DB_DRIVER_BAN). Route: delegated direct.
- [x] T3: `backup.yml` heartbeat (env-context guard `if: env.HEARTBEAT_URL != ''`, success-only)
  + monthly `backup-verify.yml` (STRICT=1, GH_TOKEN, actions: read, lts/* matching ci.yml).
  Route: delegated direct.
- [x] T4: README Rollback (schema-does-not-roll-back caveat) + Monitoring (health semantics,
  HEARTBEAT_URL wiring, 3-step alert test) + Sentry env rows. Route: delegated direct.
- [x] T5: Parent verification done. Route: inline (parent).

## Acceptance criteria

- Unauthenticated `GET /api/health` returns 200 with DB up, 503 with DB down; not redirected
  to /login by proxy.
- `npm run verify` green with no DSN set (Sentry dormant).
- Backup workflow pings heartbeat on success; no-op without secret; verify workflow runs
  monthly with STRICT=1.
- README documents rollback + monitoring end to end.

## Checks

- `npm run verify` (lint + typecheck + test + build) — writer runs, parent re-runs.
- Health route unit tests: both status paths observed.
- RDD assess per work-unit commit (base-ref = branch point `9fbb06b5421c`).

## Delivery

Forecast ~300 authored lines (under 400 budget) → strategy `ask-on-risk`, single PR slice.
Work-unit commits on `feat/production-readiness`; push/PR are user decisions.

## Progress

- 2026-10-12: feature doc created; user WIP stashed (`wip: login stale cookie loop`);
  branch `feat/production-readiness` from `9fbb06b5421c`.
- 2026-10-12: T1–T4 implemented by delegated writer (15 files, all within allowed surfaces).
- 2026-10-12: T5 verification: writer `npm run verify` exit 0 (no DSN, Sentry dormant);
  parent spot check `npm run verify` exit 0; independent read-only verifier PASS 7/7,
  no defects (matcher proven with Next's bundled path-to-regexp; heartbeat guard validated
  against GitHub steps.if context availability; targeted vitest 12/12 green).
- 2026-10-12: RDD assess (`--base-ref 9fbb06b5421c --committed-only`): typed result
  `unassessable` — opencode runtime not eligible for immutable receipt review (supported:
  claude-code, codex). Treated as tier high per contract → independent verifier run (above).
  Result preserved; mode not toggled.

Work-unit commits (evidence):

- `f1dbe692f697` feat(health,observability): add /api/health uptime endpoint and optional
  Sentry error reporting (T1+T2 — shared files src/proxy.ts / src/proxy.test.ts kept one unit)
- `c66eabf225b5` ci(backup): heartbeat dead-man switch and monthly restore-drill verification (T3)
- `0c3d281cdda0` docs: rollback and monitoring operations (T4)

## Next step

User-owned: `git stash pop` (login-loop WIP), push/PR decision, then manual activation —
Sentry DSN in Vercel envs, uptime monitor on /api/health, HEARTBEAT_URL secret
(`gh secret set HEARTBEAT_URL`), one manual backup-verify dispatch to prove the chain.
