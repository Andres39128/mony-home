/**
 * Lazy monthly interest accrual for rate-bearing loans (annual_rate_bp).
 *
 * Called on READ paths (listLoans → getPatrimony → /prestamos, dashboard
 * patrimony) — there is NO cron. Every elapsed WHOLE month since the accrual
 * base (max of creation month, last interest row month) materializes ONE
 * visible 'interest' payment dated the month start:
 *   charge = round(outstanding_before × annual_rate_bp / 12 / 10000)
 * where outstanding_before = principal + interest − payments dated strictly
 * before that month start. Payments made mid-month only reduce the NEXT
 * month's charge — the balance DECLINES month over month.
 *
 * Idempotent under concurrency too: the whole catch-up runs in one
 * transaction holding the loan row FOR UPDATE, and a partial unique index
 * (loan_id, date, note WHERE kind='interest') backs the invariant at the
 * DB level — a racing request inserts nothing.
 */
import { and, eq, isNotNull, max } from "drizzle-orm";
import { loanPayments, loans } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { formatRatePercent } from "@/features/savings/math";

/** Months since year 0 for a 'YYYY-MM-DD' string — comparable and add/subtract friendly. */
function monthIndexOfIso(iso: string): number {
  const [year, month] = iso.split("-").map(Number);
  return year * 12 + (month - 1);
}

/** Same, for a Date (local timezone — same clock the forms use). */
function monthIndexOfDate(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

/** First day of the month index as 'YYYY-MM-01'. */
function monthStartIso(monthIndex: number): string {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

interface AccrualBase {
  annualRateBp: number | null;
  principalCents: number;
  createdAt: Date;
}

/**
 * Brings one loan's interest up to `now`. Returns the number of interest
 * rows inserted (0 when no rate / zero elapsed months / non-positive
 * outstanding).
 */
export async function catchUpInterest(
  db: Database,
  loanId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the loan row: concurrent view requests serialize here, so the
    // loser re-reads the base after the winner committed and no-ops.
    const [loan] = await tx
      .select({
        annualRateBp: loans.annualRateBp,
        principalCents: loans.principalCents,
        createdAt: loans.createdAt,
      })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1)
      .for("update");
    if (!loan) return 0;

    return accrueLoan(tx, loanId, loan as AccrualBase, now);
  });
}

/** Rate-bearing loans only — one indexed query when there are none. */
export async function catchUpAllLoanInterest(db: Database, now: Date = new Date()): Promise<void> {
  const rows = await db
    .select({ id: loans.id })
    .from(loans)
    .where(isNotNull(loans.annualRateBp));
  for (const row of rows) {
    await catchUpInterest(db, row.id, now);
  }
}

/** Any Postgres drizzle database — the app pool in production, PGlite in tests. */
type AccrualDb = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function accrueLoan(
  db: AccrualDb,
  loanId: string,
  loan: AccrualBase,
  now: Date,
): Promise<number> {
  const rateBp = loan.annualRateBp;
  if (rateBp === null) return 0;

  const [last] = await db
    .select({ lastInterest: max(loanPayments.date) })
    .from(loanPayments)
    .where(and(eq(loanPayments.loanId, loanId), eq(loanPayments.kind, "interest")));

  const baseMonth = Math.max(
    monthIndexOfDate(loan.createdAt),
    last?.lastInterest ? monthIndexOfIso(last.lastInterest) : 0,
  );
  const nowMonth = monthIndexOfDate(now);
  if (nowMonth <= baseMonth) return 0; // zero elapsed whole months → no-op

  // Ledger rows older than the current month drive every accrual step.
  const rows = await db
    .select({
      kind: loanPayments.kind,
      amountCents: loanPayments.amountCents,
      date: loanPayments.date,
    })
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(loanPayments.date);
  const before = rows.filter((row) => monthIndexOfIso(row.date) < nowMonth);

  // Outstanding starts at the principal; payments subtract, interest adds.
  let outstanding = loan.principalCents;
  let inserted = 0;
  let cursor = 0;
  const note = `Interés ${formatRatePercent(rateBp)}% TNA`;

  for (let month = baseMonth + 1; month <= nowMonth; month++) {
    const start = monthStartIso(month);
    while (cursor < before.length && before[cursor].date < start) {
      const row = before[cursor];
      outstanding += row.kind === "payment" ? -row.amountCents : row.amountCents;
      cursor++;
    }
    // Monthly compounding on the DECLINING balance: rate/12.
    const chargeCents = Math.round((outstanding * rateBp) / 12 / 10000);
    if (chargeCents > 0) {
      // Savepoint wrapper: the unique index backs the invariant even if a
      // writer bypassed the row lock. The error must propagate so drizzle
      // rolls back to the savepoint and the tx stays usable.
      try {
        await db.transaction(async (nested) => {
          await nested.insert(loanPayments).values({
            loanId,
            memberId: null,
            kind: "interest",
            amountCents: chargeCents,
            date: start,
            note,
          });
        });
      } catch (error) {
        // Another writer already covered this month — keep what exists.
        if (!hasPgError(error, "23505")) throw error;
      }
      outstanding += chargeCents;
      inserted++;
    }
  }
  return inserted;
}
