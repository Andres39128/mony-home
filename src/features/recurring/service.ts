/**
 * Recurring movements service — monthly auto-materialized transactions
 * (rent, subscriptions, salary). Admin CRUD; materialization lives in
 * catch-up.ts (lazy, read-path driven, no cron).
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Amounts arrive as free text and ALWAYS go through the
 * shared money parser (R2) with movements-style ambiguity discrimination.
 *
 * Delete is always allowed: the FK on transactions.recurring_id is SET NULL,
 * so already-materialized movements stay in the ledger as plain movements.
 * Pausing (isActive=false) is the non-destructive alternative.
 */
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, recurringMovements, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import type { SessionUser } from "@/lib/auth";
import { parseAmountCents } from "@/lib/money-errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Validation (trust boundary)
// ---------------------------------------------------------------------------

export const recurringSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(64, "Máximo 64 caracteres"),
  type: z.enum(["income", "expense"]),
  /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
  amount: z.string().trim().min(1, "El monto es obligatorio"),
  categoryId: z.string().regex(UUID_RE, "Categoría inválida"),
  memberId: z.string().regex(UUID_RE, "Integrante inválido"),
  scope: z.enum(["individual", "common"]).default("common"),
  /** Calendar day 1..28: February's shortest month guarantees it exists. */
  dayOfMonth: z.coerce
    .number({ message: "El día debe ser un número entre 1 y 28" })
    .int("El día debe ser un número entre 1 y 28")
    .min(1, "El día debe ser un número entre 1 y 28")
    .max(28, "El día debe ser un número entre 1 y 28"),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
});

export type RecurringInput = z.output<typeof recurringSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RecurringView {
  id: string;
  name: string;
  type: "income" | "expense";
  amountCents: number;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  memberId: string;
  memberName: string;
  scope: "individual" | "common";
  dayOfMonth: number;
  note: string | null;
  isActive: boolean;
  /** 'YYYY-MM-01' — newest month already materialized; null = never. */
  lastMaterializedMonth: string | null;
}

export type RecurringResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_amount"
        | "ambiguous_amount"
        | "category_kind_mismatch"
        | "member_inactive"
        | "not_found"
        | "forbidden";
    };

/** Every recurring (active first), with category/member labels for the cards. */
export async function listRecurring(db: Database): Promise<RecurringView[]> {
  const rows = await db
    .select({
      id: recurringMovements.id,
      name: recurringMovements.name,
      type: recurringMovements.type,
      amountCents: recurringMovements.amountCents,
      categoryId: recurringMovements.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      memberId: recurringMovements.memberId,
      memberName: users.name,
      scope: recurringMovements.scope,
      dayOfMonth: recurringMovements.dayOfMonth,
      note: recurringMovements.note,
      isActive: recurringMovements.isActive,
      lastMaterializedMonth: recurringMovements.lastMaterializedMonth,
    })
    .from(recurringMovements)
    .innerJoin(categories, eq(recurringMovements.categoryId, categories.id))
    .innerJoin(users, eq(recurringMovements.memberId, users.id))
    .orderBy(
      sql`case when ${recurringMovements.isActive} then 0 else 1 end`,
      asc(recurringMovements.dayOfMonth),
      asc(recurringMovements.name),
    );
  return rows;
}

// ---------------------------------------------------------------------------
// Mutations (admin-only, enforced here — UI hiding is never trusted)
// ---------------------------------------------------------------------------

/** Category must exist and match the movement kind; member must be active. */
async function checkReferences(
  db: Database,
  input: RecurringInput,
): Promise<RecurringResult | null> {
  const [category] = await db
    .select({ kind: categories.kind })
    .from(categories)
    .where(eq(categories.id, input.categoryId))
    .limit(1);
  if (!category) return { ok: false, error: "not_found" };
  if (category.kind !== input.type) return { ok: false, error: "category_kind_mismatch" };

  const [member] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, input.memberId))
    .limit(1);
  if (!member) return { ok: false, error: "not_found" };
  if (!member.isActive) return { ok: false, error: "member_inactive" };
  return null;
}

function recurringValues(input: RecurringInput, cents: number) {
  return {
    name: input.name,
    type: input.type,
    amountCents: cents,
    categoryId: input.categoryId,
    memberId: input.memberId,
    scope: input.scope,
    dayOfMonth: input.dayOfMonth,
    note: input.note ? input.note : null,
  };
}

export async function createRecurring(
  db: Database,
  user: SessionUser,
  input: RecurringInput,
): Promise<RecurringResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  const cents = parseAmountCents(input.amount);
  if (cents === "ambiguous_amount") return { ok: false, error: "ambiguous_amount" };
  if (cents === "invalid_amount" || cents <= 0) return { ok: false, error: "invalid_amount" };

  const ruleError = await checkReferences(db, input);
  if (ruleError) return ruleError;

  try {
    await db.insert(recurringMovements).values(recurringValues(input, cents));
    return { ok: true };
  } catch (error) {
    // A referenced row deleted between the checks and the insert.
    if (hasPgError(error, "23503")) return { ok: false, error: "not_found" };
    throw error;
  }
}

export async function updateRecurring(
  db: Database,
  user: SessionUser,
  id: string,
  input: RecurringInput,
): Promise<RecurringResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  const cents = parseAmountCents(input.amount);
  if (cents === "ambiguous_amount") return { ok: false, error: "ambiguous_amount" };
  if (cents === "invalid_amount" || cents <= 0) return { ok: false, error: "invalid_amount" };

  const ruleError = await checkReferences(db, input);
  if (ruleError) return ruleError;

  try {
    const updated = await db
      .update(recurringMovements)
      .set(recurringValues(input, cents))
      .where(eq(recurringMovements.id, id))
      .returning({ id: recurringMovements.id });
    if (updated.length === 0) return { ok: false, error: "not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "not_found" };
    throw error;
  }
}

/**
 * Pause/resume: paused recurrings stop materializing WHILE paused; on
 * resume the lazy catch-up materializes the elapsed months (the obligation
 * existed) — same catch-up semantics as the savings/loans engines.
 */
export async function toggleRecurringActive(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<RecurringResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(recurringMovements)
    .set({ isActive: sql`not ${recurringMovements.isActive}` })
    .where(eq(recurringMovements.id, id))
    .returning({ id: recurringMovements.id });
  if (updated.length === 0) return { ok: false, error: "not_found" };
  return { ok: true };
}

/**
 * Always allowed — already-materialized movements survive as plain
 * movements (transactions.recurring_id goes NULL via the FK).
 */
export async function removeRecurring(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<RecurringResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const deleted = await db
    .delete(recurringMovements)
    .where(eq(recurringMovements.id, id))
    .returning({ id: recurringMovements.id });
  if (deleted.length === 0) return { ok: false, error: "not_found" };
  return { ok: true };
}
