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
- [ ] T1: Núcleo semántico (UN commit atómico — la app queda consistente):
  `sumIncomeExpense` cash/card split + `transactionTotals` (+cardExpenseCents) + `openingBalanceCents` cash-only + espejo amortizador en `addCardPayment` + seed "Pago de tarjetas" + analytics cash-only + tests (transactions service, loans service, analytics). Ruta: delegated (writer).
- [ ] T2: UI consumers: /movimientos (Gastos cash, card Tarjeta aparte, Saldo), dashboard hero/KPIs, presupuesto, insights/assistant context (+sus tests). Ruta: delegated (mismo writer).
- [ ] T3: Higiene: comentarios stale, copy engañoso, sweep huérfanos, `npm run verify` completo. Ruta: delegated (mismo writer).

## Progress / evidence
(vacío)

## Next step
Delegar T1+T2+T3 a un writer con verification commands; al volver: readback + spot check + RDD assess sobre el diff (RDD on).

## Route declaration
T1–T3 delegated (writer trigger: 2+ archivos no triviales; lectura-preparación-para-escribir pertenece al writer).
