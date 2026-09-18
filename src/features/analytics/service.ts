/**
 * Analytics service — read-only aggregations powering the dashboard charts.
 *
 * Lives in its own feature (not src/features/transactions) because these
 * queries span transactions AND budgets; keeping them here leaves the
 * transactions service mutation-centric and avoids coupling it to budget
 * reads. All functions are pure-ish over the DB (no Next.js imports) so
 * they test against PGlite like every other service.
 *
 * Movement-side conditions come from transactions.filtersWhere — ONE place
 * builds transaction WHERE clauses for the whole app. Money is ALWAYS
 * integer cents; percentages via money.percentage (2 decimals, 0 on
 * divide-by-zero).
 */
import { and, desc, eq, gte, lte, sql, sum } from "drizzle-orm";
import { budgets, categories, transactions } from "@/db/schema";
import type { Database } from "@/db";
import { percentage } from "@/lib/money";
import {
  filtersWhere,
  type TransactionFilters,
} from "@/features/transactions/service";
import { monthBounds } from "@/features/budgets/progress";
import { previousMonth } from "@/features/budgets/service";

export interface CategoryExpenseSlice {
  categoryId: string;
  name: string;
  color: string;
  cents: number;
  /** Share of the filtered total, 2 decimals (0 when there is no total). */
  pct: number;
}

/** Expense-only total grouped by category, biggest first, honoring filters. */
export async function expensesByCategory(
  db: Database,
  filters: TransactionFilters = {},
): Promise<CategoryExpenseSlice[]> {
  // The chart is about expenses; the type filter is forced, never inherited.
  const rows = await db
    .select({
      categoryId: transactions.categoryId,
      name: categories.name,
      color: categories.color,
      cents: sum(transactions.amountCents),
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(filtersWhere({ ...filters, type: "expense" }))
    .groupBy(transactions.categoryId, categories.name, categories.color)
    .orderBy(desc(sum(transactions.amountCents)));

  const slices = rows.map((row) => ({ ...row, cents: Number(row.cents ?? 0) }));
  const totalCents = slices.reduce((total, slice) => total + slice.cents, 0);
  return slices.map((slice) => ({ ...slice, pct: percentage(slice.cents, totalCents) }));
}

export interface MonthlyTotal {
  /** 'YYYY-MM'. */
  month: string;
  incomeCents: number;
  expenseCents: number;
}

/** Default window of the "últimos 12 meses" bar chart. */
export const DEFAULT_MONTHS_BACK = 12;

/**
 * Income/expense totals for the `monthsBack` months ending at `endingMonth`
 * (inclusive), oldest first. Gap months come back as ZERO rows (never
 * missing keys) so charts never break on an empty month. The month range is
 * owned by this window; every OTHER filter (member/scope/category/envelope/
 * group) is honored.
 */
export async function monthlyTotals(
  db: Database,
  endingMonth: string,
  monthsBack: number = DEFAULT_MONTHS_BACK,
  filters: TransactionFilters = {},
): Promise<MonthlyTotal[]> {
  const endingBounds = monthBounds(endingMonth);
  if (!endingBounds || monthsBack < 1) return [];

  // Oldest → newest, built by walking backwards from the window end.
  const months: string[] = [endingMonth];
  while (months.length < monthsBack) months.unshift(previousMonth(months[0]));

  const monthKey = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
  const rows = await db
    .select({
      month: monthKey,
      income: sum(
        sql`case when ${transactions.type} = 'income' then ${transactions.amountCents} end`,
      ),
      expense: sum(
        sql`case when ${transactions.type} = 'expense' then ${transactions.amountCents} end`,
      ),
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.date, `${months[0]}-01`),
        lte(transactions.date, endingBounds.end),
        // The window replaces any incoming month filter.
        filtersWhere({ ...filters, month: undefined }),
      ),
    )
    .groupBy(monthKey);

  const byMonth = new Map(rows.map((row) => [row.month, row]));
  return months.map((month) => {
    const row = byMonth.get(month);
    return {
      month,
      incomeCents: Number(row?.income ?? 0),
      expenseCents: Number(row?.expense ?? 0),
    };
  });
}

export interface CumulativeBudgetPoint {
  /** 'YYYY-MM'. */
  month: string;
  plannedCumCents: number;
  actualCumCents: number;
}

/**
 * Cumulative planned-vs-actual expense for ONE calendar year, January up to
 * the filter month when it falls in that year (else December — the page
 * always passes the selected month, so no future-zero spam). A month with
 * no budget row contributes 0 to the planned curve; the actual curve sums
 * expense transactions honoring the movement filters. The budget plan side
 * honors the category filter (plans are per category); member/scope/
 * envelope/group have no meaning for a plan and are ignored there.
 * No data at all → [] (the chart shows its empty state).
 */
export async function cumulativeBudgetVsActual(
  db: Database,
  year: number,
  filters: TransactionFilters = {},
): Promise<CumulativeBudgetPoint[]> {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return [];
  const endMonthNumber =
    filters.month && filters.month.startsWith(`${year}-`)
      ? Number(filters.month.slice(5, 7))
      : 12;
  const firstMonth = `${year}-01`;
  const endMonth = `${year}-${String(endMonthNumber).padStart(2, "0")}`;
  const endBounds = monthBounds(endMonth);
  if (!endBounds) return [];

  const months: string[] = [endMonth];
  while (months[0] !== firstMonth) months.unshift(previousMonth(months[0]));

  const [plannedRows, actualRows] = await Promise.all([
    db
      .select({ month: budgets.month, planned: sum(budgets.amountCents) })
      .from(budgets)
      .where(
        and(
          // budgets.month is stored as the month's first-day date.
          gte(budgets.month, `${firstMonth}-01`),
          lte(budgets.month, `${endMonth}-01`),
          filters.categoryId ? eq(budgets.categoryId, filters.categoryId) : undefined,
        ),
      )
      .groupBy(budgets.month),
    db
      .select({
        month: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
        spent: sum(transactions.amountCents),
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, "expense"),
          gte(transactions.date, `${firstMonth}-01`),
          lte(transactions.date, endBounds.end),
          filtersWhere({ ...filters, month: undefined, type: undefined }),
        ),
      )
      .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`),
  ]);

  if (plannedRows.length === 0 && actualRows.length === 0) return [];

  const plannedByMonth = new Map(
    plannedRows.map((row) => [row.month.slice(0, 7), Number(row.planned ?? 0)]),
  );
  const actualByMonth = new Map(actualRows.map((row) => [row.month, Number(row.spent ?? 0)]));

  const points: CumulativeBudgetPoint[] = [];
  let plannedCumCents = 0;
  let actualCumCents = 0;
  for (const month of months) {
    plannedCumCents += plannedByMonth.get(month) ?? 0;
    actualCumCents += actualByMonth.get(month) ?? 0;
    points.push({ month, plannedCumCents, actualCumCents });
  }
  return points;
}
