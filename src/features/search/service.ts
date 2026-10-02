/**
 * Global search (F6) — one query box over movements, savings goals and loans.
 *
 * Derived on read, zero new state. Movements go through a bounded SQL ILIKE
 * (the transactions table is unbounded, so filtering + limiting happens in
 * Postgres); goals and loans REUSE listGoals/listLoans and filter in JS —
 * those tables are household-scale and the views already carry the computed
 * netCents/outstandingCents, so the ledger math is never duplicated.
 *
 * Trust boundary: the user query becomes a literal case-insensitive
 * substring (%/_ escaped, same pattern as the transactions filtersWhere);
 * input shorter than 2 characters yields an empty result object, never an
 * error, and longer input is clamped.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { categories, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { listGoals } from "@/features/savings/service";
import { listLoans } from "@/features/loans/service";

/** Minimum meaningful query: below it the search is a no-op (never an error). */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** Query cap: longer input is clamped instead of rejected. */
export const SEARCH_MAX_QUERY_LENGTH = 100;

/** Movements shown per search (newest first). */
export const SEARCH_MOVEMENTS_LIMIT = 20;

/** Goals/loans shown per search group. */
export const SEARCH_GROUP_LIMIT = 10;

export interface MovementHit {
  id: string;
  date: string;
  amountCents: number;
  type: "income" | "expense";
  categoryName: string | null;
  memberName: string;
}

export interface GoalHit {
  id: string;
  name: string;
  kind: "savings" | "investment";
  netCents: number;
}

export interface LoanHit {
  id: string;
  name: string;
  entity: string;
  kind: "credit_card" | "investment_line" | "mortgage" | "other";
  amortizationMode: "bank" | "revolving" | null;
  outstandingCents: number;
}

export interface SearchResults {
  movements: MovementHit[];
  bolsas: GoalHit[];
  prestamos: LoanHit[];
}

export const EMPTY_SEARCH_RESULTS: SearchResults = {
  movements: [],
  bolsas: [],
  prestamos: [],
};

/** Trimmed + clamped query — the single normalization every caller shares. */
export function normalizeQuery(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

/** Case-insensitive literal-substring match over the small views (JS side). */
function matchesQuery(fields: string[], q: string): boolean {
  const needle = q.toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(needle));
}

export async function globalSearch(db: Database, raw: string): Promise<SearchResults> {
  const q = normalizeQuery(raw);
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return EMPTY_SEARCH_RESULTS;
  // Escape LIKE wildcards so user input is always a literal substring.
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

  const [movements, goals, loans] = await Promise.all([
    db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        type: transactions.type,
        categoryName: categories.name,
        memberName: users.name,
      })
      .from(transactions)
      // leftJoin like the movements baseQuery: category is matched even when
      // a completed row somehow lacks one, and the shape stays identical.
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .innerJoin(users, eq(transactions.memberId, users.id))
      .where(
        and(
          // Pending quick-capture rows are placeholders, not money.
          eq(transactions.needsDetails, false),
          or(
            sql`${transactions.note} ILIKE ${pattern}`,
            sql`${categories.name} ILIKE ${pattern}`,
            sql`${users.name} ILIKE ${pattern}`,
          ),
        ),
      )
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(SEARCH_MOVEMENTS_LIMIT),
    listGoals(db),
    listLoans(db),
  ]);

  return {
    movements,
    // Deterministic order before the slice: alphabetical by name, then id —
    // the inherited list order is not a contract, so the visible subset at
    // the limit must not depend on it (R3-001).
    bolsas: goals
      .filter((goal) => matchesQuery([goal.name], q))
      .sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id))
      .slice(0, SEARCH_GROUP_LIMIT)
      .map((goal) => ({ id: goal.id, name: goal.name, kind: goal.kind, netCents: goal.netCents })),
    prestamos: loans
      .filter((loan) => matchesQuery([loan.name, loan.entity], q))
      .sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id))
      .slice(0, SEARCH_GROUP_LIMIT)
      .map((loan) => ({
        id: loan.id,
        name: loan.name,
        entity: loan.entity,
        kind: loan.kind,
        amortizationMode: loan.amortizationMode,
        outstandingCents: loan.outstandingCents,
      })),
  };
}
