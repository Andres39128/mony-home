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

## Adjustment round 3 (2026-10-14, user decision after totals review)

Pre-existing defect found while reviewing the five KPI cards: "Disponible" =
planned + carry WITHOUT subtracting the month's spend, overstating what is
actually left. New formula: available = planned + carry − spent (= remaining +
carry), at row level AND totals level. Card-credit-limit availableCents in
loans/transactions is a different concept — untouched. User authorized direct
commit to main and push.

- [x] T9 TDD: flip availableCents assertions (budgets/service.test.ts rows
      ~125, 277-279, 300-301, 340, 482, 495, 540, 562, 582; insights/
      context.test.ts ~153) to planned+carry−spent; RED; then fix
      budgets/service.ts:173 and :197 + doc comments (BudgetRowView.available,
      module header mention); GREEN; full checks; work-unit commit on main.

## Adjustment round 4 (2026-10-14, user decision after seeing real numbers)

The user reversed the round-2 totals rule after reviewing live figures: the
"Pago de tarjetas" row must be FULLY inside the totals (presupuestado AND
gastado), like any other category. Accepted consequence (user-informed): the
same money counts twice in totals (purchase in its category + payment in the
settlement row). Implementation is the REMOVAL of the round-2 exclusion logic.

- [x] T10 TDD: flip round-2 assertions — budgets mirror test totals include
      the settlement row (planned +50.000, spent +45.000, carry included,
      available recomputed with round-3 formula); analytics cumulative
      unfiltered curves include the settlement category (explicit filter
      branch unchanged). RED.
- [x] T11 GREEN: remove the totals-exclusion filter in getMonth; remove the
      ne() exclusions in cumulativeBudgetVsActual; delete now-unused
      cardPaymentMirrorCategoryId (budgets) + its analytics import; update
      module-header doc comments. Full checks; work-unit commit on main; push.

## Adjustment round 5 (2026-10-14, user wants the payment-method split visible)

The single "Gastado" KPI mixes cash and card spending. User decision: the KPI
card becomes "Gastado en efectivo" (cash expenses of the month — includes the
settlement payment, which is real cash out) and a NEW KPI "Gastado con tarjeta"
(card purchases of the month). The two PARTITION the existing execution totals
(sum = totals.spentCents), so Restante / % ejecutado / Disponible / the
categories table / the settlement row are unchanged (rounds 1-4 intact).

- [x] T12 TDD: budgets service test asserts the new totals fields
      spentCashCents / spentCardCents (partition of execution by
      paymentMethod; cash includes settlement mirrors). RED.
- [x] T13 GREEN: getMonth gains the partition query + BudgetMonthView totals
      fields; /presupuesto KPI grid shows "Gastado en efectivo" and "Gastado
      con tarjeta" (6 cards). Full checks; work-unit commit on main; push.

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
- 2026-10-14 Round 2 (fila sí, total no): writer commit `6d504549b18d` on
  fix/budget-card-payment-row; 594/594 tests, typecheck, lint green; parent
  spot check 15/15 budgets tests. RDD assess for this candidate returned the
  same high/unassessable runtime-eligibility refusal; the user's standing
  continue-without-reporting decision applies — delivery under ordinary
  repository policy.
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
- 2026-10-14 Round 3 TDD RED: three numeric flips — roundtrip totals
  available 130.916 (150.050 − 19.134), mirror-test settlement row
  −5.000 (500 − 100 carry − 450 spent) and totals −40.000 (280 − 680),
  insights summary budget available −519.000 (150.000 − 363.000 − 306.000);
  formula-encoding assertions (spent 0 in their month) rewritten to
  planned+carry−spent. RED confirmed: exactly those 3 tests failed.
  Verified insights:477 (985.000) is the CARD credit availability
  (ctx.tarjetas, cupo − saldo) and page.tsx:192 a static zero fallback —
  both untouched, different concept/same word.
- 2026-10-14 Round 3 GREEN: budgets/service.ts row (~:173) and totals
  (~:197) availableCents now subtract spent; BudgetRowView.available doc
  updated. All checks green (594 tests, typecheck, lint). Work-unit commit
  on main: `fix(budgets): disponible subtracts the month's spend`.
- 2026-10-14 Round 4 TDD RED: budgets mirror test renamed ("...row counts
  in the totals") — totals planned 78.000 (500+500+50+30+200), spent
  113.000 (400+450+50+30+200), carry −10.000, available −45.000
  (780−100−1.130, round-3 formula); analytics basis test renamed —
  unfiltered 2026-03 planned 30.000 / actual 62.000 (settlement 15.000/
  12.000 included, card purchase 7.000 still in), explicit-filter branch
  unchanged. RED confirmed: exactly those two tests failed (totals still
  28.000). No other fixture carries a settlement category (re-verified:
  insights untouched).
- 2026-10-14 Round 4 GREEN: round-2 exclusion logic REMOVED — getMonth
  totals reduce over all rows; cardPaymentMirrorCategoryId deleted from
  budgets (findMirrorCategoryId import with it; grep: no importers left);
  cumulativeBudgetVsActual ne() exclusions and the helper call/import
  removed (explicit categoryId filter branch kept). Module headers state
  the final rule: every category row, settlement included, counts in
  totals (user-accepted double count). All checks green (594 tests,
  typecheck, lint). Work-unit commit on main:
  `fix(budgets): settlement row counts fully in budget totals`.
- 2026-10-14 Round 5 TDD RED: three tests extended — roundtrip totals
  toEqual gains spentCashCents 19.134 / spentCardCents 0 (toEqual is
  exact, would fail without them); carry-test February split 40.000 cash
  + 25.000 card; mirror-test May split 73.000 cash (450+50+30+200
  mirrors) + 40.000 card with an explicit sum-equals-spentCents
  (113.000) assertion. RED confirmed: exactly those 3 failed on
  undefined fields.
- 2026-10-14 Round 5 GREEN: getMonth Promise.all gains a groupBy
  paymentMethod query on the SAME execution WHERE; totals gain
  spentCashCents/spentCardCents (derived from the query, spentCents
  untouched). /presupuesto KPI grid: "Gastado" replaced by "Gastado en
  efectivo" + "Gastado con tarjeta" (both danger-fill), 6 cards,
  lg:grid-cols-6, order Presupuestado/Efectivo/Tarjeta/Restante/
  Disponible/% ejecutado. Blast radius verified safe: insights
  summary.budget picks fields explicitly (no leak, 594 tests green);
  dashboard fallback `??` union only reads pct/plannedCents/spentCents.
  All checks green (594 tests, typecheck, lint). Work-unit commit on
  main: `feat(budgets): split Gastado KPI into cash and card`.

## Adjustment round 6 (2026-10-14, KPI clarity pass)

User feedback: cards not clear enough. Presupuestado OK; cash+card spend must
be ONE card; Restante/Disponible need plain-language subtitles; user believed
"arrastre" = last month's card spend (corrected in conversation: it is the net
plan−spent accumulation of every prior month per category).

- [x] T14 /presupuesto KPI grid back to 5 cards: "Gastado" shows the total
      with sub-line "Efectivo: X · Con tarjeta: Y"; Restante sub-line "lo que
      queda: presupuesto − gastado del mes"; Disponible sub-line "restante +
      arrastre: X". Presentational only — service and tests untouched.

## Adjustment round 7 (2026-10-14, user removes arrastre entirely)

User: "Quitemos lo de arrastre, ese valor no afecta." The rollover/carry
feature is removed: no carry computation, no Arrastre chips, no Disponible
card/column (without carry, Disponible === Restante — keeping both would show
two identical figures). Carry is computed state (no schema change).

- [x] T15 TDD: budgets tests drop/flip carry+available assertions (round-1
      carry test becomes obsolete — delete); insights context expectations
      lose availableCents. RED.
- [x] T16 GREEN: getMonth loses the carry queries and carry/available fields
      (rows + totals); /presupuesto 4 KPI cards (drop Disponible, remove
      CarryChip) and table drops the Disponible column; insights summary
      drops disponible; dashboard fallback object updated; notifications
      checked. Full checks; work-unit commit on main; push.
- 2026-10-14 Round 7 TDD (feature REMOVAL — shape-pinned RED): four carry
  tests deleted (zero-first-month, positive/negative, skips-future,
  unbudgeted-prior); the round-1 carry test rewritten to keep only its
  February execution coverage (spent 65.000, split 40.000/25.000); the
  mirror test loses its carry/available keys and the April settlement
  fixture row (existed only to make carry observable). Stripped
  expectations first: the two exact-shape toEqual pins (budgets roundtrip,
  insights summary) went RED on the EXTRA carryCents/availableCents still
  returned — that pins the removal itself.
- 2026-10-14 Round 7 GREEN: getMonth drops both carry queries, the
  carryByCategory fold and every carry/available field (rows + totals) —
  totals are now planned/spent/spentCash/spentCard/pct; `lt` import gone.
  /presupuesto: 4 KPI cards (lg:grid-cols-4), Disponible card, CarryChip +
  carryChipClass, table Disponible column and mobile Disponible line
  removed. insights summary.budget reduced to planned/spent/pct (type,
  construction and prompt arrastre/disponible keys); dashboard fallback
  object drops the two keys. notifications/service.ts verified: reads only
  planned/spent/pct — untouched. grep: zero carryCents/CarryChip in src;
  surviving availableCents are all card-credit-limit, surviving "arrastre"
  mentions are the cash saldo (opening balance) concept. All checks green
  (590 tests — 4 fewer, the deleted carry tests; typecheck, lint).
  Work-unit commit on main:
  `feat(budgets): remove arrastre carry and Disponible`.
