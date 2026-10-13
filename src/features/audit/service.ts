/**
 * Audit trail (roadmap F9): an append-only record of every household
 * mutation — who did it, on what, and a one-line human-readable summary.
 *
 * DELIVERY SEMANTICS (the deliberate ceiling): recordAudit is a STANDALONE,
 * best-effort insert that runs AFTER the mutation has committed. It is
 * awaited (so tests and the request lifecycle stay deterministic) but it
 * NEVER throws and never blocks or rolls back the mutation it describes —
 * a failed audit write is logged, not propagated. Transactional coupling
 * (same-tx audit rows) was rejected on purpose: it would couple the trail's
 * fate to ~30 different call sites and turn a logging hiccup into a lost
 * user write.
 *
 * Wiring layer rule: the audit goes wherever the ACTOR exists naturally —
 * services that already take SessionUser audit themselves (testable
 * directly); services with no user parameter (member/category/group
 * creation, settings — the latter also constrained by the seed CLI's
 * no-alias import chain through lib/app-settings.ts) are audited by their
 * server actions instead.
 */
import { and, count, desc, eq, like } from "drizzle-orm";
import { auditLog, users } from "@/db/schema";
import type { Database } from "@/db";
import type { SessionUser } from "@/lib/auth";
import { formatCentsExact, parseAmountToCents } from "@/lib/money";

/** Entity names as they appear in /auditoria filters and rows. */
export const AUDIT_ENTITIES = [
  "transaction",
  "loan",
  "loan_payment",
  "goal",
  "contribution",
  "budget",
  "recurring",
  "category",
  "group",
  "member",
  "settings",
  "import",
] as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

/** Spanish labels for the entity filter and badges (one canonical map). */
export const AUDIT_ENTITY_LABELS: Record<AuditEntity, string> = {
  transaction: "Movimiento",
  loan: "Préstamo",
  loan_payment: "Pago de préstamo",
  goal: "Bolsa",
  contribution: "Aporte",
  budget: "Presupuesto",
  recurring: "Recurrente",
  category: "Categoría",
  group: "Grupo",
  member: "Integrante",
  settings: "Configuración",
  import: "Importación",
};

/**
 * Best-effort audit insert. entityId is '' when the entity was created in
 * this very mutation (the generated id is not surfaced by every service);
 * the summary carries the human-readable trace instead.
 */
export async function recordAudit(
  db: Database,
  actor: SessionUser,
  entity: AuditEntity,
  entityId: string,
  action: string,
  summary?: string,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: actor.id,
      entity,
      entityId,
      action,
      summary: summary ?? null,
    });
  } catch (error) {
    // The ceiling documented at the top: audit failure never fails the
    // mutation. console.error is the smoke signal something rotted.
    console.error(`[audit] write failed (${entity}/${action})`, error);
  }
}

/**
 * Free-text AR amount → formatted copy for audit summaries ("15000" →
 * "$ 15.000"); the raw string when it doesn't parse (never invents). Uses
 * the exact-cent renderer: zero-decimal currencies must not round here.
 */
export function auditAmount(amount: string): string {
  try {
    return formatCentsExact(parseAmountToCents(amount));
  } catch {
    return amount;
  }
}

export interface AuditFilters {
  entity?: string;
  actorId?: string;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string;
  actorName: string;
  entity: string;
  entityId: string;
  action: string;
  summary: string | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  /** Clamped 1-based page actually returned. */
  page: number;
}

/**
 * Newest-first paginated trail with actor names resolved. Filters are
 * trusted-boundary inputs (GET params): an unknown entity/actor simply
 * matches nothing rather than erroring — same lenient shape as the
 * movements filters.
 */
export async function listAudits(
  db: Database,
  filters: AuditFilters,
  page: number,
  pageSize: number,
): Promise<AuditPage> {
  const where = and(
    filters.entity ? like(auditLog.entity, filters.entity) : undefined,
    filters.actorId ? eq(auditLog.actorId, filters.actorId) : undefined,
  );

  const [countRow] = await db.select({ total: count() }).from(auditLog).where(where);
  const total = countRow.total;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), lastPage);

  const rows = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorName: users.name,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      action: auditLog.action,
      summary: auditLog.summary,
    })
    .from(auditLog)
    .innerJoin(users, eq(auditLog.actorId, users.id))
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  return { rows, total, page: safePage };
}
