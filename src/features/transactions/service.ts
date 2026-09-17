/**
 * Transactions (movements) service — the centerpiece feature.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Creating is open to any authenticated member (always
 * attributed to themselves unless an admin says otherwise); editing and
 * deleting are restricted to the transaction's own member or an admin
 * (no created_by column exists — member_id IS the ownership column).
 * Amounts arrive as free text and ALWAYS go through money.parseAmountToCents
 * (R2); positivity is re-checked here after parsing.
 *
 * Integrity rules enforced here (never trusted to the UI):
 * 1. Category kind must match the transaction type.
 * 2. Envelopes must be active; an individual envelope only accepts movements
 *    from its own member (common envelopes accept anyone).
 * 3. Only active expense groups can be attached to new/updated movements.
 */
import { and, desc, eq, gte, lte, sql, sum, type SQL } from "drizzle-orm";
import { z } from "zod";
import { categories, envelopes, expenseGroups, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { parseAmountToCents } from "@/lib/money";
import type { SessionUser } from "@/lib/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local-timezone ISO date ('YYYY-MM-DD'); shared by schema default and pages. */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export const movementSchema = z.object({
  /** Empty string = today (quick-entry forms always send a date; API tolerance). */
  date: z
    .union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")])
    .transform((v) => (v === "" ? todayIso() : v)),
  /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
  amount: z.string().trim().min(1, "El monto es obligatorio"),
  type: z.enum(["income", "expense"]),
  categoryId: z.string().regex(UUID_RE, "Categoría inválida"),
  /** Empty string = the acting user (create default); admins may target anyone. */
  memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
  envelopeId: z.union([z.string().regex(UUID_RE, "Bolsa inválida"), z.literal("")]),
  groupId: z.union([z.string().regex(UUID_RE, "Grupo inválido"), z.literal("")]),
  scope: z.enum(["individual", "common"]).default("common"),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
});

export type MovementInput = z.output<typeof movementSchema>;

export type MovementMutationError =
  | "invalid_amount"
  | "category_kind_mismatch"
  | "envelope_member_mismatch"
  | "envelope_inactive"
  | "group_closed"
  | "not_found"
  | "forbidden";

export type MovementResult =
  | { ok: true }
  | { ok: false; error: MovementMutationError };

export interface TransactionView {
  id: string;
  date: string;
  amountCents: number;
  type: "income" | "expense";
  scope: "individual" | "common";
  note: string | null;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  memberId: string;
  memberName: string;
  envelopeId: string | null;
  envelopeName: string | null;
  groupId: string | null;
  groupName: string | null;
}

export interface TransactionFilters {
  /** 'YYYY-MM'; the required filter in the UI, optional at service level. */
  month?: string;
  categoryId?: string;
  memberId?: string;
  envelopeId?: string;
  groupId?: string;
  type?: "income" | "expense";
}

const viewColumns = {
  id: transactions.id,
  date: transactions.date,
  amountCents: transactions.amountCents,
  type: transactions.type,
  scope: transactions.scope,
  note: transactions.note,
  categoryId: transactions.categoryId,
  categoryName: categories.name,
  categoryColor: categories.color,
  memberId: transactions.memberId,
  memberName: users.name,
  envelopeId: transactions.envelopeId,
  envelopeName: envelopes.name,
  groupId: transactions.groupId,
  groupName: expenseGroups.name,
};

function baseQuery(db: Database) {
  return db
    .select(viewColumns)
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .innerJoin(users, eq(transactions.memberId, users.id))
    .leftJoin(envelopes, eq(transactions.envelopeId, envelopes.id))
    .leftJoin(expenseGroups, eq(transactions.groupId, expenseGroups.id));
}

/** Inclusive [firstDay, lastDay] of 'YYYY-MM', or null for malformed input. */
function monthRange(month: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  // Day 0 of month index `monthNumber` = last day of the 1-based month.
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}

function filtersWhere(filters: TransactionFilters): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  // Empty strings ( untouched GET-form selects) count as "no filter".
  if (filters.month) {
    const range = monthRange(filters.month);
    if (range) {
      conds.push(gte(transactions.date, range.start), lte(transactions.date, range.end));
    }
  }
  if (filters.categoryId) conds.push(eq(transactions.categoryId, filters.categoryId));
  if (filters.memberId) conds.push(eq(transactions.memberId, filters.memberId));
  if (filters.envelopeId) conds.push(eq(transactions.envelopeId, filters.envelopeId));
  if (filters.groupId) conds.push(eq(transactions.groupId, filters.groupId));
  if (filters.type) conds.push(eq(transactions.type, filters.type));
  const clean = conds.filter((c): c is SQL => c !== undefined);
  return clean.length > 0 ? and(...clean) : undefined;
}

export async function listTransactions(
  db: Database,
  filters: TransactionFilters = {},
): Promise<TransactionView[]> {
  return baseQuery(db)
    .where(filtersWhere(filters))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));
}

export async function getTransaction(
  db: Database,
  id: string,
): Promise<TransactionView | null> {
  const rows = await baseQuery(db).where(eq(transactions.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface TransactionTotals {
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
}

export async function transactionTotals(
  db: Database,
  filters: TransactionFilters = {},
): Promise<TransactionTotals> {
  const [row] = await db
    .select({
      income: sum(sql`case when ${transactions.type} = 'income' then ${transactions.amountCents} end`),
      expense: sum(sql`case when ${transactions.type} = 'expense' then ${transactions.amountCents} end`),
    })
    .from(transactions)
    .where(filtersWhere(filters));
  const incomeCents = Number(row?.income ?? 0);
  const expenseCents = Number(row?.expense ?? 0);
  return { incomeCents, expenseCents, balanceCents: incomeCents - expenseCents };
}

/** Returns null when the free-text amount cannot be parsed (typed error path). */
function parseAmountCents(amount: string): number | null {
  try {
    const cents = parseAmountToCents(amount);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

/** Member attribution: empty = the acting user; non-admins cannot target others. */
function resolveMemberId(user: SessionUser, input: MovementInput):
  | { ok: true; memberId: string }
  | { ok: false; error: "forbidden" } {
  const memberId = input.memberId === "" ? user.id : input.memberId;
  if (user.role !== "admin" && memberId !== user.id) return { ok: false, error: "forbidden" };
  return { ok: true, memberId };
}

interface ReferencedRows {
  category: { kind: "income" | "expense" } | null;
  envelope: { isActive: boolean; scope: "individual" | "common"; memberId: string | null } | null;
  group: { status: "active" | "closed" } | null;
}

/** Loads category/envelope/group so rules 1-3 can be checked before writing. */
async function loadReferencedRows(
  db: Database,
  input: MovementInput,
): Promise<ReferencedRows> {
  const [category, envelope, group] = await Promise.all([
    db
      .select({ kind: categories.kind })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .limit(1),
    input.envelopeId
      ? db
          .select({ isActive: envelopes.isActive, scope: envelopes.scope, memberId: envelopes.memberId })
          .from(envelopes)
          .where(eq(envelopes.id, input.envelopeId))
          .limit(1)
      : Promise.resolve([]),
    input.groupId
      ? db
          .select({ status: expenseGroups.status })
          .from(expenseGroups)
          .where(eq(expenseGroups.id, input.groupId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  return { category: category[0] ?? null, envelope: envelope[0] ?? null, group: group[0] ?? null };
}

/** Rules 1-3: category kind, envelope activity/ownership, group status. */
function checkReferencedRows(
  rows: ReferencedRows,
  input: MovementInput,
  memberId: string,
): MovementMutationError | null {
  if (!rows.category) return "not_found";
  if (rows.category.kind !== input.type) return "category_kind_mismatch";
  if (input.envelopeId) {
    if (!rows.envelope) return "not_found";
    if (!rows.envelope.isActive) return "envelope_inactive";
    if (rows.envelope.scope === "individual" && rows.envelope.memberId !== memberId) {
      return "envelope_member_mismatch";
    }
  }
  if (input.groupId) {
    if (!rows.group) return "not_found";
    if (rows.group.status !== "active") return "group_closed";
  }
  return null;
}

function movementValues(input: MovementInput, memberId: string, cents: number) {
  return {
    date: input.date,
    amountCents: cents,
    type: input.type,
    categoryId: input.categoryId,
    memberId,
    envelopeId: input.envelopeId ? input.envelopeId : null,
    groupId: input.groupId ? input.groupId : null,
    scope: input.scope,
    note: input.note ? input.note : null,
  };
}

export async function createTransaction(
  db: Database,
  user: SessionUser,
  input: MovementInput,
): Promise<MovementResult> {
  const cents = parseAmountCents(input.amount);
  if (cents === null) return { ok: false, error: "invalid_amount" };

  const member = resolveMemberId(user, input);
  if (!member.ok) return member;

  const rows = await loadReferencedRows(db, input);
  const ruleError = checkReferencedRows(rows, input, member.memberId);
  if (ruleError) return { ok: false, error: ruleError };

  try {
    await db.insert(transactions).values(movementValues(input, member.memberId, cents));
    return { ok: true };
  } catch (error) {
    // A referenced row deleted between the checks above and the insert.
    if (hasPgError(error, "23503")) return { ok: false, error: "not_found" };
    throw error;
  }
}

export async function updateTransaction(
  db: Database,
  user: SessionUser,
  id: string,
  input: MovementInput,
): Promise<MovementResult> {
  const [existing] = await db
    .select({ memberId: transactions.memberId })
    .from(transactions)
    .where(eq(transactions.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "not_found" };

  const cents = parseAmountCents(input.amount);
  if (cents === null) return { ok: false, error: "invalid_amount" };

  const member = resolveMemberId(user, input);
  if (!member.ok) return member;
  // Rule 6: members may only touch their own transactions (and keep them own).
  if (user.role !== "admin" && existing.memberId !== user.id) {
    return { ok: false, error: "forbidden" };
  }

  const rows = await loadReferencedRows(db, input);
  const ruleError = checkReferencedRows(rows, input, member.memberId);
  if (ruleError) return { ok: false, error: ruleError };

  try {
    const updated = await db
      .update(transactions)
      .set({ ...movementValues(input, member.memberId, cents), updatedAt: new Date() })
      .where(eq(transactions.id, id))
      .returning({ id: transactions.id });
    if (updated.length === 0) return { ok: false, error: "not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "not_found" };
    throw error;
  }
}

export async function removeTransaction(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<MovementResult> {
  const [existing] = await db
    .select({ memberId: transactions.memberId })
    .from(transactions)
    .where(eq(transactions.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "not_found" };
  // Rule 6: members delete only their own; admins delete any.
  if (user.role !== "admin" && existing.memberId !== user.id) {
    return { ok: false, error: "forbidden" };
  }

  const deleted = await db
    .delete(transactions)
    .where(eq(transactions.id, id))
    .returning({ id: transactions.id });
  if (deleted.length === 0) return { ok: false, error: "not_found" };
  return { ok: true };
}
