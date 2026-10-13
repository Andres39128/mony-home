# Fix amount prefill round-trip ("Monto ambiguo" on unmodified fields)

## Objective
Budget/bolsas/prestamos edit forms must save without re-validating prefilled
amounts as ambiguous.

## Problem
Edit forms prefill amount inputs with `formatCents()` — display-oriented
`Intl.NumberFormat({ style: "currency" })`. Under COP/es-CO (app_config),
whole amounts >= 1000 render as "$ 1.234" (no decimals). On save, untouched
fields submit that string and `parseAmountToCents` rejects "1.234" as
`AmbiguousAmountError` by design (es-AR/COP thousands vs dot-decimal typo).

## Why
The ambiguity guard protects human input; machine-generated prefill must emit
unambiguous text instead of weakening the parser.

## Scope
- src/lib/money.ts: add `formatCentsForInput` (plain number, 2 decimals,
  no grouping, no symbol — always round-trips).
- Swap 11 input defaultValue sites: presupuesto/budget-editor.tsx (1),
  bolsas/bolsas-panel.tsx (3), prestamos/loans-panel.tsx (7).
- Display usages (KpiCard etc.) stay on formatCents.

## Tasks
- [x] RED: round-trip property test in money.test.ts
- [x] Implement formatCentsForInput (GREEN)
- [x] Swap prefill sites in 3 panels (13 found: 1 budget + 3 bolsas + 9 loans; 2 multiline)
- [x] Suite + tsc + lint in worktree (570/570, tsc OK, eslint OK)
- [ ] Branch push -> main, deploy, report

## Verification
- `npx vitest run` (full suite)
- `npx tsc --noEmit`, `npx eslint` on touched files
- Production deploy Ready + user confirms budget edit saves

## Route
Direct inline (root cause fully diagnosed in-session; mechanical swaps).
Delivery: isolated worktree off origin/main, branch push to main (established
session convention), avoiding the concurrently-used shared checkout.
