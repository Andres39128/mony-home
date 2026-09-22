/**
 * Envelopes (bolsas) service.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. ALL mutations are admin-only and take the calling
 * SessionUser to enforce the role here (service level), not just in the UI.
 * Amounts arrive as free text and ALWAYS go through money.parseAmountToCents
 * (R2) — raw numbers never cross the form boundary.
 */
import { and, asc, eq, gte, lte, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { envelopes, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import { parseAmountToCents } from "@/lib/money";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/features/transactions/service";
import {
  computeProgress,
  monthBounds,
  type ProgressStatus,
} from "@/features/budgets/progress";

export interface EnvelopeView {
  id: string;
  name: string;
  scope: "individual" | "common";
  memberId: string | null;
  memberName: string | null;
  monthlyAmountCents: number;
  isActive: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the envelopes_individual_requires_member CHECK constraint at the
 * zod level so users get a friendly field error instead of a 500.
 */
export const envelopeSchema = z
  .object({
    name: z.string().trim().min(1, "El nombre es obligatorio").max(64, "Máximo 64 caracteres"),
    scope: z.enum(["individual", "common"]),
    /** Empty string = common envelope without owner. */
    memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
    /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
    monthlyAmount: z.string().trim().min(1, "El monto es obligatorio"),
  })
  .refine((v) => v.scope !== "individual" || v.memberId !== "", {
    message: "Las bolsas individuales requieren un integrante.",
    path: ["memberId"],
  })
  .refine((v) => v.scope !== "common" || v.memberId === "", {
    message: "Las bolsas comunes no llevan integrante.",
    path: ["memberId"],
  });

export type EnvelopeInput = z.output<typeof envelopeSchema>;

export type EnvelopeMutationError =
  | "invalid_amount"
  | "member_not_found"
  | "envelope_not_found"
  | "has_movements"
  | "forbidden";

export type EnvelopeResult =
  | { ok: true }
  | { ok: false; error: EnvelopeMutationError };

export async function listEnvelopes(db: Database): Promise<EnvelopeView[]> {
  return db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      scope: envelopes.scope,
      memberId: envelopes.memberId,
      memberName: users.name,
      monthlyAmountCents: envelopes.monthlyAmountCents,
      isActive: envelopes.isActive,
    })
    .from(envelopes)
    .leftJoin(users, eq(envelopes.memberId, users.id))
    // Common first (enum ordinals would sort 'individual' first), then by name.
    .orderBy(sql`case when ${envelopes.scope} = 'common' then 0 else 1 end`, asc(envelopes.name));
}

export interface EnvelopeProgressView {
  id: string;
  name: string;
  scope: "individual" | "common";
  memberName: string | null;
  plannedCents: number;
  spentCents: number;
  pct: number;
  remainingCents: number;
  status: ProgressStatus;
}

/**
 * Monthly progress per ACTIVE envelope: spent = expense transactions with
 * that envelope within the month (inclusive bounds); planned = the envelope's
 * monthly amount. The math is the SHARED computeProgress from budgets —
 * one source of truth for thresholds and divide-by-zero.
 */
export async function monthlyProgress(
  db: Database,
  month: string = todayIso().slice(0, 7),
): Promise<EnvelopeProgressView[]> {
  const bounds = monthBounds(month);
  if (!bounds) return [];

  const rows = await db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      scope: envelopes.scope,
      memberName: users.name,
      plannedCents: envelopes.monthlyAmountCents,
      spent: sum(transactions.amountCents),
    })
    .from(envelopes)
    .leftJoin(users, eq(envelopes.memberId, users.id))
    .leftJoin(
      transactions,
      and(
        eq(transactions.envelopeId, envelopes.id),
        eq(transactions.type, "expense"),
        // Pending quick-capture rows are placeholders, not spend.
        eq(transactions.needsDetails, false),
        gte(transactions.date, bounds.start),
        lte(transactions.date, bounds.end),
      ),
    )
    .where(eq(envelopes.isActive, true))
    .groupBy(envelopes.id, users.name)
    .orderBy(sql`case when ${envelopes.scope} = 'common' then 0 else 1 end`, asc(envelopes.name));

  return rows.map((row) => {
    const spentCents = Number(row.spent ?? 0);
    return {
      id: row.id,
      name: row.name,
      scope: row.scope,
      memberName: row.memberName,
      plannedCents: row.plannedCents,
      spentCents,
      ...computeProgress(row.plannedCents, spentCents),
    };
  });
}

/** Returns null when the free-text amount cannot be parsed (typed error path). */
function parseAmountCents(amount: string): number | null {
  try {
    return parseAmountToCents(amount);
  } catch {
    return null;
  }
}

function envelopeValues(input: EnvelopeInput, cents: number) {
  return {
    name: input.name,
    scope: input.scope,
    memberId: input.scope === "individual" ? input.memberId : null,
    monthlyAmountCents: cents,
  };
}

export async function createEnvelope(
  db: Database,
  user: SessionUser,
  input: EnvelopeInput,
): Promise<EnvelopeResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const cents = parseAmountCents(input.monthlyAmount);
  if (cents === null) return { ok: false, error: "invalid_amount" };
  try {
    await db.insert(envelopes).values(envelopeValues(input, cents));
    return { ok: true };
  } catch (error) {
    // Stale member option (deleted between render and submit).
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function updateEnvelope(
  db: Database,
  user: SessionUser,
  id: string,
  input: EnvelopeInput,
): Promise<EnvelopeResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const cents = parseAmountCents(input.monthlyAmount);
  if (cents === null) return { ok: false, error: "invalid_amount" };
  try {
    const updated = await db
      .update(envelopes)
      .set(envelopeValues(input, cents))
      .where(eq(envelopes.id, id))
      .returning({ id: envelopes.id });
    if (updated.length === 0) return { ok: false, error: "envelope_not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function toggleEnvelopeActive(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<EnvelopeResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(envelopes)
    .set({ isActive: sql`not ${envelopes.isActive}` })
    .where(eq(envelopes.id, id))
    .returning({ isActive: envelopes.isActive });
  if (updated.length === 0) return { ok: false, error: "envelope_not_found" };
  return { ok: true };
}

export async function removeEnvelope(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<EnvelopeResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    const deleted = await db
      .delete(envelopes)
      .where(eq(envelopes.id, id))
      .returning({ id: envelopes.id });
    if (deleted.length === 0) return { ok: false, error: "envelope_not_found" };
    return { ok: true };
  } catch (error) {
    // RESTRICT FK: transactions.envelope_id (23001 on PGlite, 23503 on PG 17).
    if (hasPgFkError(error)) return { ok: false, error: "has_movements" };
    throw error;
  }
}
