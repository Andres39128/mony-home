# Feature: Saldo solo efectivo (cash-basis) — tarjeta aparte

## Objective
El saldo y el total "Gastos" cuentan únicamente movimientos de efectivo. Las compras con tarjeta son deuda (cupo): se muestran aparte y golpean el saldo recién cuando se paga la tarjeta (salida de efectivo).

## Problem / Why
Hoy la semántica es inversa: una compra con tarjeta reduce el saldo inmediatamente (es `type='expense'` y `sumIncomeExpense` no distingue medio de pago) y el pago de la tarjeta NO lo reduce (`addCardPayment` no espeja capital — decisión V1 de credito-rotativo, línea "capital sin espejo"). El usuario definió el modelo correcto: la compra con tarjeta es un préstamo, no una salida de efectivo; la salida real es el pago. Los préstamos bancarios ya funcionan así (espejo "Pago de préstamos" al pagar).

Decisiones de producto (usuario, 2026-10-01):
- "Gastos" = solo efectivo, en todos lados (movimientos, dashboard, presupuesto, análisis, asistente).
- Compras con tarjeta se muestran aparte (total propio del mes en /movimientos; /prestamos ya muestra ciclos).
- Saldo = ingresos (siempre cash) − gastos cash. Arrastre cash-only.

## Semantics spec
- `sumIncomeExpense` pasa a separar por medio de pago: income (todo cash), expenseCash, expenseCard. `balanceCents = income − expenseCash`.
- `transactionTotals` expone además `cardExpenseCents` (mes filtrado) para la tarjeta "aparte".
- `openingBalanceCents`: net cash-only antes del mes (mismo helper → automático).
- `addCardPayment`: espejar la porción amortizadora (`total − interés − cuota de manejo`) como gasto cash, categoría sistema **"Pago de tarjetas"** (nueva, seed junto a las existentes), `loan_payment_id` con CASCADE. El interés y la cuota ya espejan (correcto: son salidas de efectivo propias).
- Overpayment (pago > saldo pendiente): el espejo igual es `total − interés − fee` — la plata salió del efectivo de todos modos.
- Datos históricos: sin migración — todo saldo es derivado, corte limpio (compras viejas dejan de contar, pagos nuevos empiezan a contar).
- La lista de movimientos, filtros, CSV y badge de tarjeta NO cambian (se siguen listando las filas card).

## Consumers a auditar (grep balanceCents / transactionTotals / sumIncomeExpense / completedOnly)
- src/app/(app)/movimientos/page.tsx (Gastos card → cash; nueva card Tarjeta; Saldo = arrastre + net cash)
- src/app/(app)/page.tsx (hero balanceCents + KPI strip)
- src/app/(app)/presupuesto/page.tsx:50 + budget view (ejecución = gastos cash)
- src/features/analytics/service.ts (breakdowns de gasto → cash-only)
- src/features/insights/context.ts:374,511 (asistente: balance/gastos cash + cardExpense aparte)
- Comentarios stale en db/schema.ts y loans/service.ts que documenten "capital sin espejo" / "la compra ya fue gasto"
- Copy de tour/prestamos que describa el comportamiento viejo (flaggear, no reescribir de más)

## Authorized scope / constraints
- Repo: mony-home, rama feat/saldo-solo-efectivo desde main (b55adacc97b3).
- Reglas de calidad del usuario: sin hardcodeo (constantes), sin duplicación (helpers compartidos), sin código huérfano, análisis de contexto antes de editar, npm run verify al cerrar.
- Artefactos técnicos en inglés; UI copy español rioplatense existente.
- Commits convencionales, sin Co-Authored-By. Work-unit commits (ver Tareas).

## TDD mode
Off — tests funcionales junto a cada fase (patrón repo: vitest + PGlite, *.test.ts junto a la feature).

## Delivery strategy
ask-on-risk (default). Forecast ~350–500 líneas changed con tests → probable que cruce ~400: aplicar strategy antes del commit que cruce el presupuesto.

## Tasks
- [x] T1: Núcleo semántico (commit 17e96c82d984): `sumIncomeExpense` cash/card split, `transactionTotals` + `cardExpenseCents`, helper compartido `cashOnly`, `openingBalanceCents` cash-only, espejo amortizador en `addCardPayment` (`total − interés − fee`, skip si 0), seed "Pago de tarjetas" + demo mirror, analytics + budgets cash-only, tests. Ruta: delegated (writer).
- [x] T2: UI consumers (commit 2700ec360c79): /movimientos 4 cards (Gastos "En efectivo", Tarjeta aparte, Saldo cash), dashboard KPI Tarjeta, presupuesto vía service (page sin cambios), insights `cardExpenseCents` + `compras_con_tarjeta` en prompt, tour copy. Ruta: delegated (mismo writer).
- [x] T3: Higiene (en commit 2): comentarios stale en schema.ts/loans/service.ts actualizados, sin huérfanos (`cashOnly` ×3 consumers, `cardExpenseCents` ×3, `MIRROR_CARD_PAYMENT_CATEGORY`), lint 0 warnings, typecheck OK, build OK. Ruta: delegated.

## Progress / evidence
- [x] Commits: 17e96c82d984 (core), 2700ec360c79 (UI+higiene), ea56dd68ff23 (docs). Total 604 líneas changed / 17 paths.
- [x] Verificación (writer, foreground): suites tocadas 203/204 passed; 1 fallo preexistente en main (loans/accrual.test.ts:273, dependiente del reloj — probado con stash en main b55adacc97b3). lint 0, typecheck 0, build OK.
- [x] Spot check padre: diff stat confirmado; hunks nucleares releídos (split case-when, espejo capital con CASCADE); transactions suite re-ejecutada 46/46.
- [x] RDD: assess medium (slice_budget_reached, 604 líneas) → consent granted → review lineage review-c61cbc7dbb628b1f, lens review-reliability → **approved + acknowledged** (authority burned).
- [x] R3-001 fixeado (commit dba827169766): `capitalCents` se calcula antes de los checks; "Pago de tarjetas" se exige solo si `capitalCents > 0`; test de regresión renombrando la categoría (FK intacta). 42/42 loans suite, typecheck OK. RDD: assess medium 58 líneas, review_due false (under_budget).

## Next step
Entrega: cadena stacked-to-main elegida por el usuario (2026-10-01). Post-rebase shas: core=1ffb4a7b62a5, ui=0beae928bbd4, r3fix=9326a6668cd6, docs=e7bf2092cff0/3894f76a0609/2a8fe753442d.

## Chain plan (stacked to main) — ABIERTA
- PR#7 `fix/update-outstanding-clock` (a6bfb62025fb, 15 líneas) → main. Baseline: test de accrual clock-dependent fallaba en main desde 2026-10-01; ahora inyectable `now`. 459/459 suite completa verde.
- PR#8 `feat/saldo-cash-basis-core` (1ffb4a7b62a5, 485 líneas) → base PR#7. Núcleo cash-basis. **size:exception**: flip semántico indivisible (exclusión de compras card + espejo del pago deben landar juntos o el saldo pierde ambos lados); tests viajan con su unidad.
- PR#9 `feat/saldo-solo-efectivo` (3f61c19721eb, ~210 líneas) → base PR#8. UI consumers + fix R3-001 + docs. 462/462 suite completa.
- Merge order: #7 → #8 → #9. Al mergear #7, GitHub re-targetea #8 a main automáticamente.
- Deploy: tras merge correr `npm run db:seed` (categoría sistema "Pago de tarjetas" — no viene por migración).

## Route declaration
T1–T3 delegated (writer trigger: 2+ archivos no triviales; lectura-preparación-para-escribir pertenece al writer).
