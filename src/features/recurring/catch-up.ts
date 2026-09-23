/**
 * Lazy MONTHLY materialization for recurring movements.
 *
 * Called on READ paths (dashboard, /movimientos) — there is NO cron. Every
 * ACTIVE recurring materializes ONE transaction per elapsed month, dated its
 * dayOfMonth:
 *
 * - The CREATION MONTH never materializes: the first materialization is the
 *   first month AFTER creation — the same "base day doesn't accrue" rule the
 *   savings engine applies to the creation day.
 * - The CURRENT month waits for its dayOfMonth (app timezone): a row dated
 *   in the future would distort month totals, so it is not written early.
 * - dayOfMonth is CHECK-constrained to 1..28, so EVERY calendar month
 *   contains that day (February's 28 defines the cap) — no date clamping.
 *
 * Each materialized row is note = the recurring's name, needsDetails = false,
 * recurring_id = set; idempotency is layered:
 *   1. last_materialized_month advances in the SAME transaction as the
 *      inserts, so a committed movement row always implies the pointer
 *      covers its month — there is no committed state that replays.
 *   2. The recurring row is locked FOR UPDATE and the pending check is
 *      re-run inside the lock, so concurrent readers serialize and the
 *      loser no-ops (accrual precedent).
 *   3. The partial unique index (recurring_id, date) backs the invariant at
 *      the DB level even against a writer that bypassed 1-2.
 *
 * COLD GATE: one indexed SELECT of active recurrings computes pending-ness
 * in JS; when nothing is pending (steady state) ZERO write transactions are
 * opened — steady-state reads pay exactly one cheap query.
 */
import { eq } from "drizzle-orm";
import { recurringMovements, transactions } from "@/db/schema";
import type { Database } from "@/db";
import { todayIso } from "@/lib/date";

/** Months since year 0 for a 'YYYY-MM-DD' string — comparable, add/subtract friendly. */
function monthIndexOfIso(iso: string): number {
  const [year, month] = iso.split("-").map(Number);
  return year * 12 + (month - 1);
}

/** First day of a month index as 'YYYY-MM-01'. */
function monthStartIso(monthIndex: number): string {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Two-digit day ('5' → '05') for the date string. */
function paddedDay(dayOfMonth: number): string {
  return String(dayOfMonth).padStart(2, "0");
}

interface RecurringRow {
  dayOfMonth: number;
  lastMaterializedMonth: string | null;
  createdAt: Date;
}

/**
 * The newest month this recurring may materialize NOW: the current month,
 * stepped back one while its dayOfMonth hasn't arrived in the app timezone.
 */
function targetMonthFor(row: RecurringRow, today: string): number {
  const current = monthIndexOfIso(`${today.slice(0, 7)}-01`);
  const todayDay = today.slice(8, 10);
  return todayDay < paddedDay(row.dayOfMonth) ? current - 1 : current;
}

/** First month that still needs a row: the month AFTER the strongest base. */
function baseMonthFor(row: RecurringRow): number {
  return Math.max(
    // Creation month in the app timezone — never materialized itself.
    monthIndexOfIso(`${todayIso(row.createdAt).slice(0, 7)}-01`),
    row.lastMaterializedMonth ? monthIndexOfIso(row.lastMaterializedMonth) : Number.NEGATIVE_INFINITY,
  );
}

/** Cold-gate predicate: is there at least one month to materialize? */
function isPending(row: RecurringRow, today: string): boolean {
  return targetMonthFor(row, today) > baseMonthFor(row);
}

/**
 * Brings every active recurring up to `now`. Returns the number of
 * transactions inserted (0 in steady state — the common case).
 */
export async function catchUpRecurringMovements(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const today = todayIso(now);
  const candidates = await db
    .select({
      id: recurringMovements.id,
      dayOfMonth: recurringMovements.dayOfMonth,
      lastMaterializedMonth: recurringMovements.lastMaterializedMonth,
      createdAt: recurringMovements.createdAt,
    })
    .from(recurringMovements)
    .where(eq(recurringMovements.isActive, true));

  let inserted = 0;
  for (const row of candidates) {
    if (!isPending(row, today)) continue; // cold gate: skip without a write tx
    inserted += await materializeOne(db, row.id, today);
  }
  return inserted;
}

/** All months for ONE recurring, inside a single FOR UPDATE transaction. */
async function materializeOne(db: Database, id: string, today: string): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the row: concurrent view requests serialize here, so the loser
    // re-reads last_materialized_month after the winner committed and no-ops.
    const [row] = await tx
      .select()
      .from(recurringMovements)
      .where(eq(recurringMovements.id, id))
      .limit(1)
      .for("update");
    if (!row || !row.isActive) return 0;
    if (!isPending(row, today)) return 0;

    const baseMonth = baseMonthFor(row);
    const target = targetMonthFor(row, today);
    const values = [];
    for (let month = baseMonth + 1; month <= target; month++) {
      values.push({
        date: `${monthStartIso(month).slice(0, 7)}-${paddedDay(row.dayOfMonth)}`,
        amountCents: row.amountCents,
        type: row.type,
        categoryId: row.categoryId,
        memberId: row.memberId,
        scope: row.scope,
        note: row.name,
        needsDetails: false,
        recurringId: row.id,
      });
    }

    // The pointer update rides the SAME transaction: either both land or
    // neither does — a committed movement never replays.
    await tx.insert(transactions).values(values);
    await tx
      .update(recurringMovements)
      .set({ lastMaterializedMonth: monthStartIso(target) })
      .where(eq(recurringMovements.id, id));
    return values.length;
  });
}
