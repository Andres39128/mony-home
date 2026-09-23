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
 * 2. Only active expense groups can be attached to new/updated movements.
 */
import { and, desc, eq, gte, lte, sql, sum, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  categories,
  expenseGroups,
  movementReceipts,
  transactions,
  users,
} from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { AmbiguousAmountError, parseAmountToCents } from "@/lib/money";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/lib/date";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Annotation stamped on quick-capture rows until their details are completed. */
export const PENDING_DETAILS_NOTE = "Pendiente incluir detalles.";

/** Receipt size cap: 2 MB. Mirrored client-side in movement-form (best effort). */
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

const RECEIPT_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Trusted-optional receipt: an untouched <input type="file"> submits an empty File. */
const optionalReceiptSchema = z
  .instanceof(File)
  .optional()
  .transform((file) => (file && file.size > 0 ? file : undefined));

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
  groupId: z.union([z.string().regex(UUID_RE, "Grupo inválido"), z.literal("")]),
  scope: z.enum(["individual", "common"]).default("common"),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
  /** Optional attached receipt image. */
  receipt: optionalReceiptSchema,
});

/** Captura rápida: the receipt IS the movement; everything else is optional. */
export const quickMovementSchema = z.object({
  date: z
    .union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")])
    .transform((v) => (v === "" ? todayIso() : v)),
  memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
  type: z.enum(["income", "expense"]).default("expense"),
  receipt: z
    .instanceof(File, { message: "La imagen es obligatoria" })
    .refine((file) => file.size > 0, "La imagen es obligatoria"),
});

export type MovementInput = z.output<typeof movementSchema>;
export type QuickMovementInput = z.output<typeof quickMovementSchema>;

export type MovementMutationError =
  | "invalid_amount"
  | "ambiguous_amount"
  | "category_kind_mismatch"
  | "member_inactive"
  | "group_closed"
  | "receipt_too_large"
  | "receipt_invalid_type"
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
  /** null only on pending quick-capture rows (they are completed via edit). */
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  memberId: string;
  memberName: string;
  groupId: string | null;
  groupName: string | null;
  needsDetails: boolean;
  receiptId: string | null;
}

export interface TransactionFilters {
  /** 'YYYY-MM'; the required filter in the UI, optional at service level. */
  month?: string;
  categoryId?: string;
  memberId?: string;
  groupId?: string;
  type?: "income" | "expense";
  /** Ámbito: household-wide or personal movements (dashboard filter). */
  scope?: "individual" | "common";
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
  groupId: transactions.groupId,
  groupName: expenseGroups.name,
  needsDetails: transactions.needsDetails,
  receiptId: movementReceipts.id,
};

function baseQuery(db: Database) {
  return db
    .select(viewColumns)
    .from(transactions)
    // leftJoin, not innerJoin: pending quick-capture rows have no category
    // yet and MUST stay visible in the list (that is how users find them).
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .innerJoin(users, eq(transactions.memberId, users.id))
    .leftJoin(expenseGroups, eq(transactions.groupId, expenseGroups.id))
    // At most one receipt per movement (service replaces by delete+insert).
    .leftJoin(movementReceipts, eq(movementReceipts.transactionId, transactions.id));
}

/** Inclusive [firstDay, lastDay] of 'YYYY-MM', or null for malformed input. */
function monthRange(month: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  // Day 0 of month index `monthNumber` = last day of the 1-based month.
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}

/**
 * WHERE clause for the shared movement filters. Exported so the analytics
 * aggregations build IDENTICAL conditions instead of a diverging copy.
 */
export function filtersWhere(filters: TransactionFilters): SQL | undefined {
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
  if (filters.groupId) conds.push(eq(transactions.groupId, filters.groupId));
  if (filters.type) conds.push(eq(transactions.type, filters.type));
  if (filters.scope) conds.push(eq(transactions.scope, filters.scope));
  const clean = conds.filter((c): c is SQL => c !== undefined);
  return clean.length > 0 ? and(...clean) : undefined;
}

/**
 * AND NOT pending, composed onto a filtersWhere() result. Pending quick-
 * capture rows are placeholders, not money: totals and analytics exclude
 * them while listTransactions keeps showing them (do NOT fold this into
 * filtersWhere — the list must see pending rows).
 */
export function completedOnly(where: SQL | undefined): SQL | undefined {
  const notPending = eq(transactions.needsDetails, false);
  return where ? and(where, notPending) : notPending;
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
    .where(completedOnly(filtersWhere(filters)));
  const incomeCents = Number(row?.income ?? 0);
  const expenseCents = Number(row?.expense ?? 0);
  return { incomeCents, expenseCents, balanceCents: incomeCents - expenseCents };
}

/**
 * Parses the free-text amount into cents, or returns the typed error code:
 * 'ambiguous_amount' means the input needs disambiguation (e.g. '1.234'),
 * 'invalid_amount' anything else unparseable/non-positive.
 */
function parseAmountCents(amount: string): number | "invalid_amount" | "ambiguous_amount" {
  try {
    const cents = parseAmountToCents(amount);
    return cents > 0 ? cents : "invalid_amount";
  } catch (error) {
    return error instanceof AmbiguousAmountError ? "ambiguous_amount" : "invalid_amount";
  }
}

/** Member attribution: empty = the acting user; non-admins cannot target others. */
function resolveMemberId(
  user: SessionUser,
  input: Pick<MovementInput, "memberId">,
): { ok: true; memberId: string } | { ok: false; error: "forbidden" } {
  const memberId = input.memberId === "" ? user.id : input.memberId;
  if (user.role !== "admin" && memberId !== user.id) return { ok: false, error: "forbidden" };
  return { ok: true, memberId };
}

/** The pooled client or an open transaction — only `.select` is needed. */
type RowLoader = Pick<Database, "select">;

interface ReferencedRows {
  member: { isActive: boolean } | null;
  category: { kind: "income" | "expense" } | null;
  group: { status: "active" | "closed" } | null;
}

/** Loads member/category/group so rules 1-2 can be checked before writing. */
function loadReferencedRows(
  db: RowLoader,
  memberId: string,
  input: MovementInput,
): Promise<ReferencedRows> {
  return Promise.all([
    db.select({ isActive: users.isActive }).from(users).where(eq(users.id, memberId)).limit(1),
    db
      .select({ kind: categories.kind })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .limit(1),
    input.groupId
      ? db
          .select({ status: expenseGroups.status })
          .from(expenseGroups)
          .where(eq(expenseGroups.id, input.groupId))
          .limit(1)
      : Promise.resolve([]),
  ]).then(([member, category, group]) => ({
    member: member[0] ?? null,
    category: category[0] ?? null,
    group: group[0] ?? null,
  }));
}

/** Rules 1-2: member status, category kind, group status. */
function checkReferencedRows(
  rows: ReferencedRows,
  input: MovementInput,
): MovementMutationError | null {
  if (!rows.member) return "not_found";
  if (!rows.member.isActive) return "member_inactive";
  if (!rows.category) return "not_found";
  if (rows.category.kind !== input.type) return "category_kind_mismatch";
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
    groupId: input.groupId ? input.groupId : null,
    scope: input.scope,
    note: input.note ? input.note : null,
    // Full-form movements are never pending; updating a pending row with
    // full data completes it (needsDetails flips to false).
    needsDetails: false,
  };
}

/** The transaction callback's client — shared by the receipt helpers. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The declared MIME type of an upload is client-controlled, so the bytes are
 * sniffed too: JPEG (FF D8 FF), PNG (89 50 4E 47) or RIFF/WEBP.
 */
function isSniffedImage(head: Uint8Array): boolean {
  const tag = (start: number, text: string) =>
    text.split("").every((char, index) => head[start + index] === char.charCodeAt(0));
  return (
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) ||
    (tag(0, "RIFF") && tag(8, "WEBP"))
  );
}

/** Size cap, allow-listed types and magic bytes — the upload trust boundary. */
async function validateReceipt(file: File): Promise<MovementMutationError | null> {
  if (file.size > RECEIPT_MAX_BYTES) return "receipt_too_large";
  if (!RECEIPT_MIME_TYPES.has(file.type)) return "receipt_invalid_type";
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!isSniffedImage(head)) return "receipt_invalid_type";
  return null;
}

/** At most one receipt per movement: the update path deletes before inserting. */
async function insertReceipt(tx: Tx, transactionId: string, file: File): Promise<void> {
  await tx.insert(movementReceipts).values({
    transactionId,
    bytes: Buffer.from(await file.arrayBuffer()),
    mimeType: file.type,
  });
}

export async function createTransaction(
  db: Database,
  user: SessionUser,
  input: MovementInput,
): Promise<MovementResult> {
  const cents = parseAmountCents(input.amount);
  if (typeof cents === "string") return { ok: false, error: cents };

  const member = resolveMemberId(user, input);
  if (!member.ok) return member;

  // Check + insert share one transaction: a row deleted between the rule
  // checks and the insert now surfaces as the typed FK error instead of
  // racing past the checks. The optional receipt rides the same transaction
  // so the movement never exists without its declared image.
  try {
    return await db.transaction<MovementResult>(async (tx) => {
      const rows = await loadReferencedRows(tx, member.memberId, input);
      const ruleError = checkReferencedRows(rows, input);
      if (ruleError) return { ok: false, error: ruleError };
      if (input.receipt) {
        const receiptError = await validateReceipt(input.receipt);
        if (receiptError) return { ok: false, error: receiptError };
      }
      const [created] = await tx
        .insert(transactions)
        .values(movementValues(input, member.memberId, cents))
        .returning({ id: transactions.id });
      if (input.receipt) await insertReceipt(tx, created.id, input.receipt);
      return { ok: true };
    });
  } catch (error) {
    // A referenced row deleted between the checks above and the insert.
    if (hasPgError(error, "23503")) return { ok: false, error: "not_found" };
    throw error;
  }
}

/**
 * Captura rápida: stores the receipt as a PENDING movement (0 amount, no
 * category, "Pendiente incluir detalles." note) in the same transaction as
 * the image, so the annotation can never dangle without its receipt.
 */
export async function createQuickTransaction(
  db: Database,
  user: SessionUser,
  input: QuickMovementInput,
): Promise<MovementResult> {
  const member = resolveMemberId(user, input);
  if (!member.ok) return member;

  try {
    return await db.transaction<MovementResult>(async (tx) => {
      const [memberRow] = await tx
        .select({ isActive: users.isActive })
        .from(users)
        .where(eq(users.id, member.memberId))
        .limit(1);
      if (!memberRow) return { ok: false, error: "not_found" };
      if (!memberRow.isActive) return { ok: false, error: "member_inactive" };

      const receiptError = await validateReceipt(input.receipt);
      if (receiptError) return { ok: false, error: receiptError };

      const [created] = await tx
        .insert(transactions)
        .values({
          date: input.date,
          amountCents: 0,
          type: input.type,
          categoryId: null,
          memberId: member.memberId,
          scope: "common",
          needsDetails: true,
          note: PENDING_DETAILS_NOTE,
        })
        .returning({ id: transactions.id });
      await insertReceipt(tx, created.id, input.receipt);
      return { ok: true };
    });
  } catch (error) {
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
  const cents = parseAmountCents(input.amount);
  if (typeof cents === "string") return { ok: false, error: cents };

  const member = resolveMemberId(user, input);
  if (!member.ok) return member;

  // Checks + update + receipt replace share one transaction (same TOCTOU
  // shape as create): full data always COMPLETES a pending row, and a
  // pending row must never stay pending once amount + category are set.
  try {
    return await db.transaction<MovementResult>(async (tx) => {
      const [existing] = await tx
        .select({ memberId: transactions.memberId })
        .from(transactions)
        .where(eq(transactions.id, id))
        .limit(1)
        .for("update");
      if (!existing) return { ok: false, error: "not_found" };
      // Rule 6: members may only touch their own transactions (and keep them own).
      if (user.role !== "admin" && existing.memberId !== user.id) {
        return { ok: false, error: "forbidden" };
      }

      const rows = await loadReferencedRows(tx, member.memberId, input);
      const ruleError = checkReferencedRows(rows, input);
      if (ruleError) return { ok: false, error: ruleError };
      if (input.receipt) {
        const receiptError = await validateReceipt(input.receipt);
        if (receiptError) return { ok: false, error: receiptError };
      }

      const updated = await tx
        .update(transactions)
        .set({ ...movementValues(input, member.memberId, cents), updatedAt: new Date() })
        .where(eq(transactions.id, id))
        .returning({ id: transactions.id });
      if (updated.length === 0) return { ok: false, error: "not_found" };
      if (input.receipt) {
        // Replace: delete any previous receipt, then insert the new one.
        await tx.delete(movementReceipts).where(eq(movementReceipts.transactionId, id));
        await insertReceipt(tx, id, input.receipt);
      }
      return { ok: true };
    });
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
