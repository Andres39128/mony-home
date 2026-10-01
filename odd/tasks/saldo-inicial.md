# Feature: Saldo inicial como movimiento de ajuste (opción A)

## Objective
Anclar el saldo de la app a la plata real: un movimiento de sistema "Saldo inicial" (ingreso si es positivo, gasto si se arranca en rojo) que el arrastre ya suma automáticamente. Sin schema, sin estado nuevo — el ledger sigue siendo la única fuente de verdad.

## Problem / Why
El arrastre (`openingBalanceCents`) deriva del neto de TODA la historia previa: sin punto de partida real, el saldo de la app nunca refleja la plata que el hogar ya tenía antes de usar la app. Decisión del usuario (2026-10-01): opción A (ajuste como movimiento), descartadas barrido-a-bolsas-como-código y cierre-de-mes formal (YAGNI).

## Semantics spec
- Sistema: nueva categoría de sistema **"Saldo inicial"** (seed en BOTH modes, junto a las demás). Kind: `income`.
- Service `setOpeningBalance(db, user, input)` en transactions/service.ts:
  - Admin-only (mismo gate que budgets/loans; member → `forbidden`).
  - zod: `amount` (string AR-formateado, CON signo — negativo = arrancar en rojo), `date` (ISO, no futura).
  - Parse: reusar `parseAmountCents` (verificar soporte de signo; si es unsigned-only, capturar el `-` inicial aparte). Rechazar 0/inválido/ambiguo (mismos errores tipados que movimientos).
  - Upsert de UNA fila: la fila de ajuste vigente = la más reciente con categoryId = "Saldo inicial" (nota-key del feature; solo esta acción escribe esa categoría).
    - Existe → UPDATE amountCents/date/type (type = income si ≥0... amountCents es siempre positivo en transactions; el signo va en `type`: positivo→income, negativo→expense) y memberId = actor.
    - No existe → INSERT: `{date, amountCents: |valor|, type, categoryId: saldoInicialId, memberId: actor, scope: 'common', paymentMethod: 'cash', note: 'Saldo inicial'}`.
  - Path de insert dedicado (como insertMirrorExpense): NO pasa por createTransaction (amount positivo-only y kind-matching no aplican al ajuste firmado con categoría income+type expense cuando es negativo).
  - La categoría debe existir → `system_category_missing` si el seed no corrió.
- Action `setOpeningBalanceAction` en transactions/actions.ts (mismo shape de action result que las demás: `{ok:true}` / `{ok:false, fieldErrors|error}` + revalidate /perfil y /movimientos).
- UI en `src/app/(app)/perfil/page.tsx`: card/section admin-only "Saldo inicial" — muestra el ajuste vigente (monto con signo + fecha) si existe, form con amount + date (default serverToday, max today), submit vía action. Copy español rioplatense; nota corta: "Cuenta como ingreso/gasto del mes en que lo feches — fechalo en un mes tranquilo si no querés inflar el actual" (precedente YNAB: starting balance es inflow).
- No special-casing en totales/analytics: el ajuste ES un movimiento cash (ingreso o gasto) — cuenta en Ingresos/Gastos del mes de su fecha. Sin excepciones en los agregados.

## Out of scope
- Cierre de mes / snapshots (opción C).
- Saldo inicial per-member (uno por hogar; el filtro por integrante es un edge aceptable).
- Ajustes múltiples simultáneos (la acción maneja UNA fila vigente).

## Authorized scope / constraints
- Repo: mony-home, rama feat/saldo-inicial desde main (c2833728e317).
- Reglas de calidad del usuario: sin hardcodeo, sin duplicación, sin huérfanos, npm run verify al cerrar. Artefactos técnicos English, UI copy es-RI. Commits convencionales, sin Co-Authored-By.
- TDD off — tests funcionales vitest+PGlite junto a la feature.

## Delivery strategy
ask-on-risk. Forecast ~150–250 líneas → un PR solo, bajo presupuesto.

## Tasks
- [ ] T1: Seed categoría "Saldo inicial" + service `setOpeningBalance` + action + tests (service.test.ts: forbidden member, insert positive/negative, upsert update (incl. flip de signo → cambia type), fecha futura rechazada, categoría faltante, fila cuenta en transactionTotals/openingBalanceCents). Ruta: delegated (writer).
- [ ] T2: UI /perfil (admin-only) con form + estado vigente + wiring de action. Ruta: delegated (mismo writer).
- [ ] T3: Higiene + `npm run verify` completo. Ruta: delegated (mismo writer).

## Progress / evidence
(vacío)

## Next step
Delegar T1–T3 a un writer; al volver: spot check + RDD assess + PR único.

## Route declaration
T1–T3 delegated (writer trigger: 2+ archivos no triviales).
