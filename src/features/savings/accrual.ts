/**
 * Lazy DAILY interest accrual for rate-bearing savings goals ('bolsas').
 *
 * Called on READ paths (listGoals → getPatrimony → /bolsas, dashboard
 * patrimony) — there is NO cron. Every elapsed COMPLETE day (app timezone,
 * America/Argentina/Buenos_Aires) since the accrual base — max of creation
 * day, value_updated_at day and the last interest row day — materializes ONE
 * visible 'interest' contribution dated that day, up to YESTERDAY:
 *
 * - 'compound' mode: the rate is EFFECTIVE annual (TEA). Daily factor =
 *   (1+r)^(1/365) − 1 applied to the running balance (deposits − withdrawals
 *   + prior interest), so interest earns interest.
 * - 'simple' mode: the rate is NOMINAL annual (TNA). Daily = r/365 applied
 *   to the PRINCIPAL only; interest accumulates in the balance but never
 *   earns. A withdrawal larger than the principal eats the accumulated
 *   interest first; the principal floors at 0.
 *
 * Money moves earn from the day AFTER their date (same rule the monthly
 * engine used: rows dated strictly before the earning day form the base).
 * Each cent amount is Math.round-ed per day (loans precedent).
 *
 * Idempotent under concurrency too: the whole catch-up runs in one
 * transaction holding the goal row FOR UPDATE, and a partial unique index
 * (goal_id, date, note WHERE kind='interest') backs the invariant at the
 * DB level — a racing request inserts nothing. Pre-existing monthly rows
 * keep their notes; the daily engine resumes from the last interest row + 1.
 */
import { and, eq, isNotNull, max } from "drizzle-orm";
import { savingsContributions, savingsGoals } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { todayIso } from "@/lib/date";

/** One visible ledger row per goal per day; constant note keeps the
 * (goal_id, date, note) partial unique index idempotent across rate edits. */
const DAILY_INTEREST_NOTE = "Interés diario";

const DAY_MS = 86_400_000;

/** Whole days since 1970-01-01 for a 'YYYY-MM-DD' string (calendar math only). */
function dayIndexOfIso(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Day index of a Date instant, in the app timezone. */
function dayIndexOfDate(date: Date): number {
  return dayIndexOfIso(todayIso(date));
}

/** Day index → 'YYYY-MM-DD'. */
function isoOfDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** Daily rate fraction for a goal: TEA-derived for compound, nominal for simple. */
function dailyRate(rateBp: number, mode: "simple" | "compound"): number {
  const annual = rateBp / 10_000;
  return mode === "compound" ? Math.pow(1 + annual, 1 / 365) - 1 : annual / 365;
}

interface AccrualBase {
  kind: "savings" | "investment";
  annualRateBp: number | null;
  accrualMode: "simple" | "compound" | null;
  createdAt: Date;
  valueUpdatedAt: Date | null;
}

/**
 * Brings one goal's daily interest up to `now`. Returns the number of
 * interest rows inserted (0 when not an accruing goal / no complete days).
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
        kind: savingsGoals.kind,
        annualRateBp: savingsGoals.annualRateBp,
        accrualMode: savingsGoals.accrualMode,
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

/** Rate-bearing savings goals only — one indexed query when there are none. */
export async function catchUpAllInterest(db: Database, now: Date = new Date()): Promise<void> {
  const goals = await db
    .select({ id: savingsGoals.id })
    .from(savingsGoals)
    .where(and(eq(savingsGoals.kind, "savings"), isNotNull(savingsGoals.annualRateBp)));
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
  // Investments ('acciones') are manual-valuation only: never accrued.
  if (rateBp === null || goal.kind !== "savings") return 0;
  const rate = dailyRate(rateBp, goal.accrualMode === "compound" ? "compound" : "simple");

  const [last] = await db
    .select({ lastInterest: max(savingsContributions.date) })
    .from(savingsContributions)
    .where(and(eq(savingsContributions.goalId, goalId), eq(savingsContributions.kind, "interest")));

  // First day to accrue = day AFTER the strongest base (creation, rebase,
  // last interest row). The base day itself never accrues — same rule the
  // monthly engine applied to the creation month.
  const baseDay = Math.max(
    dayIndexOfDate(goal.createdAt),
    goal.valueUpdatedAt ? dayIndexOfDate(goal.valueUpdatedAt) : Number.NEGATIVE_INFINITY,
    last?.lastInterest ? dayIndexOfIso(last.lastInterest) : Number.NEGATIVE_INFINITY,
  );
  const yesterday = dayIndexOfIso(todayIso(now)) - 1;
  if (yesterday <= baseDay) return 0; // no complete days to accrue

  // Ledger rows feed the balance day by day (rows dated < earning day).
  const rows = await db
    .select({
      kind: savingsContributions.kind,
      amountCents: savingsContributions.amountCents,
      date: savingsContributions.date,
    })
    .from(savingsContributions)
    .where(eq(savingsContributions.goalId, goalId))
    .orderBy(savingsContributions.date);

  // Compound tracks ONE running balance; simple tracks the principal the
  // interest actually earns on (withdrawals can push it negative before the
  // floor is applied, consuming accumulated interest by construction).
  let balance = 0;
  let principal = 0;
  let inserted = 0;
  let cursor = 0;

  for (let day = baseDay + 1; day <= yesterday; day++) {
    const dayIso = isoOfDayIndex(day);
    while (cursor < rows.length && rows[cursor].date < dayIso) {
      const row = rows[cursor];
      if (row.kind === "deposit") {
        balance += row.amountCents;
        principal += row.amountCents;
      } else if (row.kind === "withdrawal") {
        balance -= row.amountCents;
        principal -= row.amountCents;
        // A withdrawal above the principal means the excess was interest
        // already paid out: the earning base floors at 0 and stays there.
        principal = Math.max(principal, 0);
      } else {
        // Prior interest: earns in compound mode, never in simple mode.
        balance += row.amountCents;
      }
      cursor++;
    }

    const earningBase = goal.accrualMode === "compound" ? balance : principal;
    const interestCents = Math.round(earningBase * rate);
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
            date: dayIso,
            note: DAILY_INTEREST_NOTE,
          });
        });
      } catch (error) {
        // Another writer already covered this day — keep what exists.
        if (!hasPgError(error, "23505")) throw error;
      }
      balance += interestCents;
      inserted++;
    }
  }
  return inserted;
}
