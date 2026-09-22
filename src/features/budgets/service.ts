/**
 * Budgets service — per-month expense-category plans.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. A budget assigns a planned amount (integer cents, >= 0)
 * to an EXPENSE category for one month ('YYYY-MM', stored as its first-day
 * date string). setForMonth has REPLACE-ALL semantics for the month and runs
 * inside a single DB transaction. ALL mutations are admin-only, enforced
 * here at service level — UI hiding is never trusted.
 *
 * "Spent" is the SUM of expense transactions for the category within the
 * calendar month (inclusive bounds from monthBounds); household income and
 * expense context REUSES transactions.transactionTotals (never duplicated).
 */
import { and, asc, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { budgets, categories, transactions } from "@/db/schema";
import type { Database } from "@/db";
import { parseAmountToCents, percentage } from "@/lib/money";
import { transactionTotals } from "@/features/transactions/service";
import type { SessionUser } from "@/lib/auth";
import { computeProgress, monthBounds, type ProgressStatus } from "@/features/budgets/progress";

export interface BudgetRowView {
  categoryId: string;
  categoryName: string;
  color: string;
  plannedCents: number;
  spentCents: number;
  pct: number;
  remainingCents: number;
  status: ProgressStatus;
}

export interface BudgetMonthView {
  rows: BudgetRowView[];
  totals: { plannedCents: number; spentCents: number; pct: number };
  context: { incomeCents: number; expenseCents: number };
}

export interface BudgetEntryInput {
  categoryId: string;
  /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
  amount: string;
}

export type BudgetMutationError =
  | "forbidden"
  | "invalid_month"
  | "invalid_amount"
  | "category_kind_mismatch"
  | "category_inactive"
  | "not_found"
  | "nothing_to_copy";

export type BudgetResult =
  | { ok: true }
  | { ok: false; error: BudgetMutationError };

/** Full month view: every ACTIVE expense category (unbudgeted → planned 0). */
export async function getMonth(
  db: Database,
  month: string,
): Promise<BudgetMonthView | null> {
  const bounds = monthBounds(month);
  if (!bounds) return null;

  const [categoryRows, budgetRows, spentRows, context] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name, color: categories.color })
      .from(categories)
      .where(and(eq(categories.kind, "expense"), eq(categories.isActive, true)))
      .orderBy(asc(categories.name)),
    db
      .select({ categoryId: budgets.categoryId, amountCents: budgets.amountCents })
      .from(budgets)
      .where(eq(budgets.month, bounds.start)),
    db
      .select({ categoryId: transactions.categoryId, spent: sum(transactions.amountCents) })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, "expense"),
          // Pending quick-capture rows are placeholders, not spend.
          eq(transactions.needsDetails, false),
          gte(transactions.date, bounds.start),
          lte(transactions.date, bounds.end),
        ),
      )
      .groupBy(transactions.categoryId),
    transactionTotals(db, { month }),
  ]);

  const plannedByCategory = new Map(budgetRows.map((row) => [row.categoryId, row.amountCents]));
  const spentByCategory = new Map(spentRows.map((row) => [row.categoryId, Number(row.spent ?? 0)]));

  const rows = categoryRows.map((category) => {
    const plannedCents = plannedByCategory.get(category.id) ?? 0;
    const spentCents = spentByCategory.get(category.id) ?? 0;
    return {
      categoryId: category.id,
      categoryName: category.name,
      color: category.color,
      plannedCents,
      spentCents,
      ...computeProgress(plannedCents, spentCents),
    };
  });

  const totalsPlannedCents = rows.reduce((total, row) => total + row.plannedCents, 0);
  const totalsSpentCents = rows.reduce((total, row) => total + row.spentCents, 0);

  return {
    rows,
    totals: {
      plannedCents: totalsPlannedCents,
      spentCents: totalsSpentCents,
      pct: percentage(totalsSpentCents, totalsPlannedCents),
    },
    context: { incomeCents: context.incomeCents, expenseCents: context.expenseCents },
  };
}

/** Returns null when the free-text amount cannot be parsed (typed error path). */
function parseBudgetCents(amount: string): number | null {
  try {
    return parseAmountToCents(amount);
  } catch {
    return null;
  }
}

/**
 * REPLACE-ALL semantics: deletes every budget row of the month and inserts
 * the provided entries inside ONE transaction. Empty entries = clear month.
 */
export async function setForMonth(
  db: Database,
  user: SessionUser,
  month: string,
  entries: BudgetEntryInput[],
): Promise<BudgetResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const bounds = monthBounds(month);
  if (!bounds) return { ok: false, error: "invalid_month" };

  // Last entry per category wins; amounts are >= 0 (0 = explicitly unplanned).
  const planned = new Map<string, number>();
  for (const entry of entries) {
    const cents = parseBudgetCents(entry.amount);
    if (cents === null || cents < 0) return { ok: false, error: "invalid_amount" };
    planned.set(entry.categoryId, cents);
  }

  if (planned.size > 0) {
    const rows = await db
      .select({ id: categories.id, kind: categories.kind, isActive: categories.isActive })
      .from(categories)
      .where(inArray(categories.id, [...planned.keys()]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [categoryId] of planned) {
      const category = byId.get(categoryId);
      if (!category) return { ok: false, error: "not_found" };
      if (category.kind !== "expense") return { ok: false, error: "category_kind_mismatch" };
      if (!category.isActive) return { ok: false, error: "category_inactive" };
    }
  }

  const values = [...planned].map(([categoryId, amountCents]) => ({
    month: bounds.start,
    categoryId,
    amountCents,
  }));
  await db.transaction(async (tx) => {
    await tx.delete(budgets).where(eq(budgets.month, bounds.start));
    if (values.length > 0) await tx.insert(budgets).values(values);
  });
  return { ok: true };
}

/** 'YYYY-MM' of the month immediately before the given one (pure string math). */
export function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 1
    ? `${year - 1}-12`
    : `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
}

/**
 * Copies the previous month's budgets into `month` (replace-all, one
 * transaction). Only budgets of active expense categories are copied;
 * an empty previous month is a typed 'nothing_to_copy'.
 */
export async function copyFromPreviousMonth(
  db: Database,
  user: SessionUser,
  month: string,
): Promise<BudgetResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const bounds = monthBounds(month);
  if (!bounds) return { ok: false, error: "invalid_month" };

  const previous = await db
    .select({ categoryId: budgets.categoryId, amountCents: budgets.amountCents })
    .from(budgets)
    .innerJoin(categories, eq(budgets.categoryId, categories.id))
    .where(
      and(
        eq(budgets.month, `${previousMonth(month)}-01`),
        eq(categories.kind, "expense"),
        eq(categories.isActive, true),
      ),
    );
  if (previous.length === 0) return { ok: false, error: "nothing_to_copy" };

  await db.transaction(async (tx) => {
    await tx.delete(budgets).where(eq(budgets.month, bounds.start));
    await tx.insert(budgets).values(previous.map((row) => ({ month: bounds.start, ...row })));
  });
  return { ok: true };
}
