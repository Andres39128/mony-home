# Feature: Crédito rotativo + medio de pago en movimientos

## Objective
Registrar el medio de pago (efectivo/tarjeta) en movimientos; las compras con tarjeta alimentan un crédito rotativo (cupo) en /prestamos con interés variable manual y cuota de manejo fija.

## Problem / Why
Las compras con tarjeta de crédito deben disminuir el cupo disponible y aumentar el saldo prestado. El interés es variable (se ingresa manual al pagar); la cuota de manejo es fija (0 o X). A 1 cuota no genera intereses — queda pendiente de pagar.

## Scope
- transactions: `payment_method` ('cash'|'card') + `card_loan_id` FK RESTRICT (borrar tarjeta con compras falsificaría el historial — desactivar en cambio); CHECK card ⇔ loan set, card solo expense.
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
- [x] T1: Schema + migración (enum revolving primero, luego columnas/CHECKs) + schema tests. Ruta: inline (contexto ya cargado, core acoplado).
- [x] T2: Servicio revolving: schema form, CRUD, listLoans con compras/disponible, addCardPayment, removeLedgerEntry, helper espejo compartido, accrual skip revolving + tests.
- [ ] T3: Transactions: method/cardId + validaciones (activa, revolving, expense, cupo create/edit) + view/filters + tests.
- [ ] T4: UI /prestamos: sección crédito rotativo, form tarjeta, pago con prompt interés/fee, ciclos, corrección admin.
- [ ] T5: UI /movimientos: toggle medio de pago, select con cupo, badge, filtro, CSV.
- [ ] T6: Seed: categorías sistema + tarjeta demo + tests de seed.
- [ ] T7: Higienización + npm run verify completo.

## Progress / evidence
- [x] T1 (commit feat db): schema + migración 0012 + 11 tests schema. 53/53 schema suite. RDD: assessed medium, review granted+acknowledged (lineage review-193469cc0ab1a751); 3 WARNING informativos (FK target solo-revolving → lo cubre el servicio T3; doc SET NULL desactualizado → corregido acá; falso positivo ADD VALUE con precedente 0011). Boundary: commit T1.
- [x] T2 (este commit): loanSchema revolving (gates 3 modos), parseRevolvingConfig, listLoans con compras (subquery correlacionada) + disponible clamp, addCardPayment (sin espejo capital, espejo interés/fee, savepoint suffix retry), removeLedgerEntry CASCADE, updateOutstanding con compras, listCardCycles, accrual skip, helper espejo compartido. 72/72 loans suite.
- [ ] T3: Transactions: method/cardId + validaciones (activa, revolving, expense, cupo create/edit) + view/filters + tests.
- [ ] T4: UI /prestamos: sección crédito rotativo, form tarjeta, pago con prompt interés/fee, ciclos, corrección admin.
- [ ] T5: UI /movimientos: toggle medio de pago, select con cupo, badge, filtro, CSV.
- [ ] T6: Seed: categorías sistema + tarjeta demo.
- [ ] T7: Higienización + npm run verify completo.

## Next step
T3.
