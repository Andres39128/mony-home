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
- [x] T1 (commit 9209c80c472b): schema + migración 0012 + 11 tests schema. 53/53 schema suite. RDD: assessed medium, review granted+acknowledged (lineage review-193469cc0ab1a751); 3 WARNING informativos. Boundary: commit T1.
- [x] T2 (commit b1c8cd02eea8): motor revolving completo. 72/72 loans suite. RDD: consent granted, reviewer PENDIENTE DE COLECTAR (transporte devolvió vacío 4 veces — decisión del usuario: continuar e reintentar; lineage review-bedc52f87ad40cb6 en estado collect).
- [x] T3 (commit 40a15e40dd8f): method/cardId en transactions, cupo en create/edit/delta, vista con cardName, filtro, CSV. 451/451 total suite.
- [x] T4 (commit f29130386f5b): sección Crédito rotativo en /prestamos (cupo bar, ciclos, pago con interés/fee, corrección admin ✕).
- [x] T5 (commit b8c445bf1187): form movimientos con toggle Efectivo|Tarjeta + select con cupo, badge en filas, filtro Medio de pago, CSV.
- [x] T6 (commit 00c05c8d9e8f): categorías sistema de tarjetas + demo Visa Oro Galicia con ciclo completo.
- [x] T7: npm run verify completo (lint 1 warning preexistente, typecheck, 451/451 tests, build OK). Barrido anti-huérfanos: todos los símbolos nuevos tienen consumidores. Helper espejo y matemática de cupo compartidos (cero duplicación).
- [x] Post-T7 fix (commit 3d4d0c95616c): el reviewer T2 (5º intento capturado) marcó R3-001 — el test de ciclos dependía del reloj y rompería tras 2026-10-25. Corregido inyectando `now` en listCardCycles (patrón del repo). El lote de refutación nativo quedó bloqueado por error determinístico del provider del subagente refuter (`__managed_by`); el hallazgo se verificó manualmente con evidencia y se fixeó.

## Next step
Entrega: decidir estrategia de PR (presupuesto >400 líneas). Reviews: T1 acknowledged; T2 capturado+fixeado pero refutación nativa pendiente por defecto del runtime del subagente (lineage review-bedc52f87ad40cb6).

## Deploy Supabase (2026-09-26)
- Migración 0012 aplicada en prod (13/13) + categorías sistema sembradas (SEED_DEMO_DATA=false; admin existente intacto por onConflictDoNothing).
- GOTCHAS descubiertos: (1) DIRECT_URL de Supabase es IPv6-only y esta red no tiene ruta IPv6 → usar el SESSION pooler (mismo host del pooler, puerto 5432, acepta prepared statements; el 6543 transaction-mode NO los acepta). (2) PG real rechaza usar un valor de enum recién agregado en la MISMA transacción (55P04 unsafe use) — el migrador JS (una tx por archivo) falla con 0012; drizzle-kit CLI aplica per-statement (autocommit) y por eso funciona; aplicado manualmente con esa semántica + hash del archivo registrado en __drizzle_migrations. PGlite tolera el uso same-txn (por eso los tests pasan). (3) npm run db:migrate (CLI) hizo no-op silencioso en esta red — sin diagnóstico; el estado quedó consistente por inserción manual del hash.
