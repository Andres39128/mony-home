/**
 * Lazy monthly interest accrual for rate-bearing goals (annual_rate_bp).
 *
 * Called on READ paths (listGoals → getPatrimony → /ahorro, dashboard KPI) —
 * there is NO cron. Every elapsed WHOLE month since the accrual base
 * (max of creation month, value_updated_at month, last interest row month)
 * materializes ONE visible 'interest' contribution dated the month start:
 *   interest = round(balance_before × annual_rate_bp / 12 / 10000)
 * where balance_before = deposits − withdrawals + interest dated strictly
 * before that month start (monthly compounding, rate/12).
 *
 * Idempotent under concurrency too: the whole catch-up runs in one
 * transaction holding the goal row FOR UPDATE, and a partial unique index
 * (goal_id, date, note WHERE kind='interest') backs the invariant at the
 * DB level — a racing request inserts nothing.
 */
import { and, eq, isNotNull, max } from "drizzle-orm";
import { savingsContributions, savingsGoals } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { formatRatePercent } from "./math";

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
  createdAt: Date;
  valueUpdatedAt: Date | null;
}

/**
 * Brings one goal's interest up to `now`. Returns the number of interest
 * rows inserted (0 when no rate / zero elapsed months / zero balances).
 */
export async function catchUpInterest(
  db: Database,
  goalId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the goal row: concurrent view requests serialize here, so the
    // loser re-reads the base after the winner committed and no-ops.
    const [goal] = await tx
      .select({
        annualRateBp: savingsGoals.annualRateBp,
        createdAt: savingsGoals.createdAt,
        valueUpdatedAt: savingsGoals.valueUpdatedAt,
      })
      .from(savingsGoals)
      .where(eq(savingsGoals.id, goalId))
      .limit(1)
      .for("update");
    if (!goal) return 0;

    return accrueGoal(tx, goalId, goal as AccrualBase, now);
  });
}

/** Rate-bearing goals only — one indexed query when there are none. */
export async function catchUpAllInterest(db: Database, now: Date = new Date()): Promise<void> {
  const goals = await db
    .select({ id: savingsGoals.id })
    .from(savingsGoals)
    .where(isNotNull(savingsGoals.annualRateBp));
  for (const goal of goals) {
    await catchUpInterest(db, goal.id, now);
  }
}

/** Any Postgres drizzle database — the app pool in production, PGlite in tests. */
type AccrualDb = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function accrueGoal(
  db: AccrualDb,
  goalId: string,
  goal: AccrualBase,
  now: Date,
): Promise<number> {
  const rateBp = goal.annualRateBp;
  if (rateBp === null) return 0;

  const [last] = await db
    .select({ lastInterest: max(savingsContributions.date) })
    .from(savingsContributions)
    .where(and(eq(savingsContributions.goalId, goalId), eq(savingsContributions.kind, "interest")));

  const baseMonth = Math.max(
    monthIndexOfDate(goal.createdAt),
    goal.valueUpdatedAt ? monthIndexOfDate(goal.valueUpdatedAt) : 0,
    last?.lastInterest ? monthIndexOfIso(last.lastInterest) : 0,
  );
  const nowMonth = monthIndexOfDate(now);
  if (nowMonth <= baseMonth) return 0; // zero elapsed whole months → no-op

  // Balances before any accrued month only need rows older than this month.
  const rows = await db
    .select({
      kind: savingsContributions.kind,
      amountCents: savingsContributions.amountCents,
      date: savingsContributions.date,
    })
    .from(savingsContributions)
    .where(eq(savingsContributions.goalId, goalId))
    .orderBy(savingsContributions.date);
  const before = rows.filter((row) => monthIndexOfIso(row.date) < nowMonth);

  let balance = 0;
  let inserted = 0;
  let cursor = 0;
  const note = `Interés ${formatRatePercent(rateBp)}% TNA`;

  for (let month = baseMonth + 1; month <= nowMonth; month++) {
    const start = monthStartIso(month);
    while (cursor < before.length && before[cursor].date < start) {
      const row = before[cursor];
      const signed = row.kind === "withdrawal" ? -row.amountCents : row.amountCents;
      balance += signed;
      cursor++;
    }
    // Monthly compounding: rate/12 on the balance including prior interest.
    const interestCents = Math.round((balance * rateBp) / 12 / 10000);
    if (interestCents > 0) {
      // Savepoint wrapper: the unique index backs the invariant even if a
      // writer bypassed the row lock. The error must propagate so drizzle
      // rolls back to the savepoint and the tx stays usable.
      try {
        await db.transaction(async (nested) => {
          await nested.insert(savingsContributions).values({
            goalId,
            memberId: null,
            kind: "interest",
            amountCents: interestCents,
            date: start,
            note,
          });
        });
      } catch (error) {
        // Another writer already covered this month — keep what exists.
        if (!hasPgError(error, "23505")) throw error;
      }
      balance += interestCents;
      inserted++;
    }
  }
  return inserted;
}
