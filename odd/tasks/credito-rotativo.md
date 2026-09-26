# Feature: Crédito rotativo + medio de pago en movimientos

## Objective
Registrar el medio de pago (efectivo/tarjeta) en movimientos; las compras con tarjeta alimentan un crédito rotativo (cupo) en /prestamos con interés variable manual y cuota de manejo fija.

## Problem / Why
Las compras con tarjeta de crédito deben disminuir el cupo disponible y aumentar el saldo prestado. El interés es variable (se ingresa manual al pagar); la cuota de manejo es fija (0 o X). A 1 cuota no genera intereses — queda pendiente de pagar.

## Scope
- transactions: `payment_method` ('cash'|'card') + `card_loan_id` FK SET NULL; CHECK card ⇔ loan set, card solo expense.
- loans: modo `revolving` con `credit_limit_cents` (>0), `management_fee_cents` (>=0), `statement_day` (1..28); gates excluyentes con bank/simple; principal >= 0 en revolving.
- Saldo revolving computado: principal + Σ compras (no pending) + interest + charge − payment. Disponible = limit − saldo (tope limit; negativo = saldo a favor).
- addCardPayment: total + interés opcional + checkbox cuota de manejo; espejo de gasto SOLO interés/fee (categorías sistema); capital sin espejo.
- removeLedgerEntry (admin): corrige filas erróneas; espejos caen por CASCADE.
- Colisión 23505 note-keyed mismo día → sufijo " (2)".
- listCardCycles: historial agrupado por ciclos de corte (statement_day); pago prellenado con saldo pendiente.
- Ingresos rechazan card (servicio); cupo validado en create + edit + completar captura rápida.
- Recurrentes: SIN cambios de motor (decisión del usuario — edición manual a tarjeta).
- UI: form movimientos (toggle + select tarjetas + cupo), badge/filtro/CSV en /movimientos, sección "Crédito rotativo" en /prestamos.

Out of scope V1: compras a N cuotas, motor auto de cuota de manejo, recurrentes automáticos con tarjeta.

## Authorized scope / constraints
- Repo: mony-home (rama feat/credito-rotativo desde main). Reglas de calidad del usuario: sin hardcodeo (constantes), sin duplicación (helpers compartidos), sin código huérfano, análisis de contexto antes de editar, higienización + npm run verify al cerrar.
- Artefactos técnicos en inglés; UI copy español rioplatense existente.

## TDD mode
Off (sin configuración estricta; tests funcionales junto a cada fase — patrón del repo: vitest + PGlite).

## Delivery strategy
ask-on-risk (default). Forecast ~1200-1500 líneas changed → superará 400: aplicaré strategy antes del primer commit que cruce el presupuesto (preguntar chain strategy al usuario).

## Tasks
- [ ] T1: Schema + migración (enum revolving primero, luego columnas/CHECKs) + schema tests. Ruta: inline (contexto ya cargado, core acoplado).
- [ ] T2: Servicio revolving: schema form, CRUD, listLoans con compras/disponible, addCardPayment, removeLedgerEntry, helper espejo compartido, accrual skip revolving + tests.
- [ ] T3: Transactions: method/cardId + validaciones (activa, revolving, expense, cupo create/edit) + view/filters + tests.
- [ ] T4: UI /prestamos: sección crédito rotativo, form tarjeta, pago con prompt interés/fee, ciclos, corrección admin.
- [ ] T5: UI /movimientos: toggle medio de pago, select con cupo, badge, filtro, CSV.
- [ ] T6: Seed: categorías sistema + tarjeta demo + tests de seed.
- [ ] T7: Higienización + npm run verify completo.

## Progress / evidence
(vacio — se actualiza por tarea con commits)

## Next step
T1.
