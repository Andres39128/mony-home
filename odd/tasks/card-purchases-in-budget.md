# Feature: Card purchases count toward the monthly budget

## Objective

Card movements (`paymentMethod='card'`) must be reflected in the monthly budget: each
card purchase counts as spent in its real category, in the month the purchase was made.

## Problem

Budget "spent" per category is cash-basis: `cashOnly` (transactions/service.ts:351)
filters `paymentMethod='cash'`, so card purchases never reach the budget execution
figure (budgets/service.ts:113 month, :129 carry). The user relies on the budget to
reflect reality — a card purchase always affects a category within the month.

## Why now

User report (2026-10-14): the system works well otherwise, but card movements are
missing from the monthly budget and must affect it.

## Root cause (verified)

- Card purchase = normal expense transaction, mandatory category, `paymentMethod='card'`,
  `cardLoanId` set (schema CHECK `(paymentMethod='card') = (cardLoanId IS NOT NULL)`).
- `cashOnly` deliberately excludes them ("card purchases are card debt, not budget
  execution" — old documented design, now changing).
- Double-count hazard: paying the card mirrors the amortizing capital as a CASH expense
  under system category "Pago de tarjetas" (linked via `loanPaymentId`). Once card
  purchases count, that mirror must NOT count, or the same money enters the budget twice
  (totals always; per-category when users budget "Pago de tarjetas").

## New rule (budget execution basis)

Budget spent = completed expenses of the month where
`paymentMethod IN ('cash','card')` — i.e. drop `cashOnly` —
EXCLUDING mirrors `loanPaymentId IS NOT NULL AND categoryId = <Pago de tarjetas>`.

Unchanged on purpose:
- "Intereses de tarjetas" and "Cuota de manejo de tarjetas" mirrors still count (real
  new expenses at payment time).
- "Pago de préstamos" mirrors still count (real cash outflow; loans are not expenses
  anywhere else).
- Cash-flow figures (saldo, transactionTotals, expensesByCategory breakdown) stay
  cash-basis — they model cash, not budget execution.

## Scope

- src/features/budgets/service.ts — month spent + carry spent use the new basis.
- src/features/analytics/service.ts — `cumulativeBudgetVsActual` actual curve must use
  the same basis (it is literally budget-vs-actual; leaving it cash-basis would
  contradict the budget page).
- Tests: budgets/service.test.ts (flip "card purchases never drag" expectation),
  analytics/service.test.ts (budget-vs-actual curve), insights/context.test.ts only if
  its getMonth fixtures shift.
- Header docs in budgets/service.ts rewritten to the new rule.

Out of scope: making expensesByCategory / transactionTotals accrual (they stay
cash-basis by design).

## Constraints

- Reuse `findMirrorCategoryId` (loans/service.ts) for the system category lookup — no
  new state, no migration.
- No schema changes.
- TDD: flip tests first (RED), then implement (GREEN) — vitest + PGlite.

## Checklist

- [x] T1 RED: budgets/service.test.ts — card purchase same-month counts in its
      category; capital mirror "Pago de tarjetas" excluded (no double count); interest,
      fee and "Pago de préstamos" mirrors still count; carry uses the same basis.
- [x] T2 GREEN: implement budget-execution basis in budgets/service.ts (month + carry),
      replacing `cashOnly`; rewrite the header comment to the new rule.
- [x] T3 Align analytics `cumulativeBudgetVsActual` + tests.
- [x] T4 Check insights/context expectations; update only if fixtures shift.
- [x] T5 Full `npm run test`, `npm run typecheck`, `npm run lint` green; work-unit
      commit on fix/budget-card-purchases.

## Adjustment round 2 (2026-10-14, user decision: "fila sí, total no")

The user reviewed and wants card payments VISIBLE in the budget: the payment
fills the "Pago de tarjetas" row against its own plan, while that row stays OUT
of the general totals (planned + spent + carry, symmetric) so the same money
never counts twice in totals. Per-category numbers were never double-counted
(mirrors only exist in the settlement category), so the mirror exclusion in the
spent aggregation becomes dead and is removed.

- [x] T6 RED: budgets mirror test — "Pago de tarjetas" row spent 45.000 with its
      own plan; totals exclude the row (planned and spent); totals spent still
      68.000 (400+50+30+200). Analytics cumulative: row in, unfiltered curves
      exclude the settlement category.
- [x] T7 GREEN: drop mirror exclusion from the spent aggregation (budgetExecution
      collapses to completedOnly — delete the builder); exclude the settlement
      category from getMonth totals and from cumulativeBudgetVsActual's unfiltered
      curves (explicit categoryId filter still wins); update doc comments
      (budgets header, cardPaymentMirrorCategoryId, analytics header,
      insights/context.test.ts comment).
- [x] T8 Full `npm run test`, `npm run typecheck`, `npm run lint`; work-unit
      commit on fix/budget-card-payment-row.

## Acceptance criteria

- A card purchase in month M with category C increases C's spent (and totals) in M's
  budget, by its full amount.
- Paying the card does not change any budget figure except via interest/fee mirrors.
- Cash-only behavior of saldo/totals/expensesByCategory is unchanged (existing tests
  still pass unmodified except the budget-vs-actual one).

## Route record

- Exploration: delegated (explore agent) — root cause `cashOnly`, mirror semantics,
  blast radius, test inventory.
- Implementation: delegated single writer (2+ non-trivial files).
- Route reason: writer trigger fired (multi-file behavior change with test flips).

## Progress log

- 2026-10-14 Branch fix/budget-card-purchases created. Exploration complete.
- 2026-10-14 TDD RED: budgets tests flipped ("card purchases count in their
  month and drag": Feb spent 65.000, April carry 35.000) + new capital-mirror
  exclusion test; analytics cumulative tests flipped (actual cum 50.000,
  category-filtered 37.000). RED confirmed: exactly the target tests failed.
- 2026-10-14 GREEN: transactions.budgetExecution builder (completed expenses,
  cash+card, excludes loanPaymentId+Pago de tarjetas capital mirrors); budgets
  month/carry and analytics cumulativeBudgetVsActual now use it via the shared
  budgets.cardPaymentMirrorCategoryId (reuses loans.findMirrorCategoryId; null
  category → no exclusion, correct because card payments fail without it).
  Insights untouched: it reuses budgets.getMonth and its fixtures carry no
  card transactions, so no expectation shifts.
- 2026-10-14 All checks green (594 tests, typecheck, lint). Work-unit commit:
  `fix(budgets): include card purchases in monthly budget execution`.
- 2026-10-14 Parent spot check: budgets tests 15/15 on the committed tree;
  stale cash-basis comments in insights/context.test.ts corrected and amended
  (hooks ran normally, healing the writer's `--no-verify`). Final commit:
  `84cdbf30e867`.
- 2026-10-14 Native review (RDD on, default): `gentle-ai review assess`
  returned risk high / unassessable and preflight STATUS refused with
  `immutable_review_transport_unsupported` (runtime eligibility). User chose
  continue-without-reporting; no native review cycle ran. Delivery under
  ordinary repository policy.
- 2026-10-14 Round 2 TDD RED: budgets mirror test renamed/flipped —
  "Pago de tarjetas" planned 500/spent 450 (pct 90, warn, carry −100 from
  an unbudgeted April settlement spend); totals planned 280 (500+300+2000,
  settlement 5000 excluded), spent 680, carry 0 (its −100 excluded);
  analytics basis test flipped — unfiltered cumulative curves exclude the
  settlement category (planned 15.000, actual 50.000 with the category's
  own 15.000/12.000 filtered in). RED confirmed: exactly the two target
  tests failed (settlement row spent came back 0).
- 2026-10-14 Round 2 GREEN: budgetExecution deleted (collapsed to
  completedOnly at both call sites — capital mirrors only ever sit in the
  settlement category, so per-category figures never double count);
  getMonth totals filter the settlement row out of planned/spent/carry
  (row kept, overCount keeps counting it; null id → no exclusion);
  cumulativeBudgetVsActual excludes the settlement category from both
  unfiltered curves via ne(), explicit categoryId filter wins. Fixture
  gotcha: setForMonth'ed categories must have the month budget cleared
  before the category delete (budgets FK is RESTRICT). All checks green
  (594 tests, typecheck, lint). Work-unit commit:
  `fix(budgets): card payments fill their budget row, excluded from totals`.
