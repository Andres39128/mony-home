# Roadmap: mony-home → app de finanzas de hogar completa

## Modelo de negocio (decisión del usuario, 2026-10-01)
El hogar es una OLLA COMÚN: ingresos y gastos se agrupan sin importar quién pagó. ⇒ Transferencias entre integrantes/reintegros = FUERA DE SCOPE por diseño (no es un gap). El sistema ya modela esto correctamente (scope common + atribución informativa).

## Decisiones de producto (lazy-defensibles, documentadas)
1. **Moneda parametrizable** (F1): nueva sección Configuración (admin) con `currencyCode` + `locale`. Instancia de este hogar: **COP + es-CO** (el usuario pidió "todo en COP"); sin hardcodear — DB-backed para todos los integrantes. El parser de montos (dot-miles/coma-decimales) ya sirve para es-CO.
2. **Rollover** (F2): arrastre NETO por categoría (positivo Y negativo — misma filosofía honesta que el saldo), COMPUTADO de la historia (cero estado nuevo): disponible(M) = plan(M) + acumulado no gastado hasta M−1.
3. **Recurrentes** (F3): frecuencias mensual/semanal/anual + `paymentMethod` cash|card (+ cardLoanId). Catch-up materializa por fecha de ocurrencia con dedup existente (recurringId+date).
4. **Proyecciones** (F4): derivadas, sin estado nuevo. ETA de meta (ritmo de aportes + interés actual) y fecha de pago de deuda (cuota vs outstanding).
5. **Import CSV** (F5): wizard genérico (pegar/subir → mapear columnas → preview → importar), admin-only, dedup por (fecha, monto, nota normalizada), auditado.
6. **Búsqueda global** (F6): spotlight unificado (movimientos por nota/categoría/integrante + bolsas + préstamos por nombre).
7. **Notificaciones** (F7): DERIVADAS in-app (campana + página /notificaciones): presupuesto ≥80%, cierre de tarjeta en ≤3 días, meta por vencer en ≤30 días, cuota próxima. Sin infra de push/email (YAGNI).
8. **Multi-moneda** (F8): currency en bolsas de inversión + tasa de cambio MANUAL por moneda en Configuración; patrimonio convierte a moneda base. **Ajuste por inflación: FUERA de este ciclo** (requiere serie de índice — futuro).
9. **Audit trail** (F9): tabla `audit_log` + writes en services (mutations: actor, entidad, acción, summary) + página admin /auditoria.

## Fases (orden por dependencia y valor)
- F1 Configuración + moneda parametrizable (+ fix bug COP en prompt del asistente). BASE de F8.
- F2 Rollover de presupuesto (computed) + UI "disponible".
- F3 Recurrentes: frecuencias + tarjeta.
- F4 Proyecciones (bolsas + préstamos + contexto asistente).
- F5 Import CSV (wizard + dedup + audit).
- F6 Búsqueda global.
- F7 Notificaciones in-app derivadas.
- F8 Multi-moneda en inversiones + FX manual.
- F9 Audit trail + /auditoria.
Cada fase: branch feat/*, verify completo, PR (encadenados si >400 líneas), merge con CI.

## Out of scope (explícito)
Transferencias inter-integrantes (modelo olla común), ajuste por inflación (necesita serie de índice), push/email (notificaciones derivadas in-app), 2FA, offline de datos (SW static-only por diseño de seguridad).
