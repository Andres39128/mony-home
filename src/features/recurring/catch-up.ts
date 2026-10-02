/**
 * Lazy materialization for recurring movements — monthly, weekly and
 * annual frequencies.
 *
 * Called on READ paths (dashboard, /movimientos) — there is NO cron. Every
 * ACTIVE recurring materializes one transaction per elapsed OCCURRENCE,
 * dated the occurrence's own day:
 *
 * - monthly: one per month, dated dayOfMonth.
 * - annual: one per year, dated dayOfMonth of the creation month (month
 *   indices ≡ creation month mod 12 — a 02-29-style drifting anniversary
 *   cannot happen because dayOfMonth caps at 28).
 * - weekly: every week on the ISO weekday of the CREATION date (the user
 *   cannot pick it — zero extra state, zero form fields). dayOfMonth is
 *   inert for weekly rows (kept only for the 1..28 CHECK).
 *
 * Shared rules:
 * - The CREATION occurrence never materializes (monthly/annual: the
 *   creation month is skipped; weekly: dates > the creation day) — the
 *   same "base day doesn't accrue" rule the savings engine applies.
 * - The current month waits for its dayOfMonth (monthly/annual); weekly
 *   occurrences wait for their own date. A row dated in the future would
 *   distort month totals, so nothing is written early.
 *
 * Each materialized row is note = the recurring's name, needsDetails =
 * false, recurring_id = set, payment_method/card_loan_id copied from the
 * recurring (card rows consume the card's cupo — see below); idempotency
 * is layered:
 *   1. last_materialized_month advances in the SAME transaction as the
 *      inserts, so a committed movement row always implies the pointer
 *      covers its month — there is no committed state that replays
 *      (monthly/annual).
 *   2. The recurring row is locked FOR UPDATE and the pending check is
 *      re-run inside the lock, so concurrent readers serialize and the
 *      loser no-ops (accrual precedent).
 *   3. The partial unique index (recurring_id, date) backs the invariant
 *      at the DB level even against a writer that bypassed 1-2.
 *
 * WEEKLY WARM PATH: the month-grained pointer cannot express intra-month
 * progress, so a weekly recurring is always "pending" — every catch-up
 * re-scans the open month and replays its already-materialized dates,
 * which the unique index (3) absorbs as no-ops. That keeps weekly
 * occurrences landing on their own day (same freshness as monthly) at the
 * cost of one cheap no-op write transaction per weekly recurring per read.
 *
 * COLD GATE: one indexed SELECT of active recurrings computes pending-ness
 * in JS; when nothing is pending (steady state, monthly/annual) ZERO write
 * transactions are opened.
 *
 * CARD RULES AT MATERIALIZATION: the recurring was validated at the trust
 * boundary (active revolving card + cupo) on create/update. At
 * materialization time the batch is re-checked once against the card's
 * CURRENT facts; an inactive/non-revolving/over-cupo card skips the
 * inserts but STILL advances the pointer — the same "skip, no silent
 * backfill on reactivation" precedent as the deactivated category/member.
 */
import { eq } from "drizzle-orm";
import { categories, recurringMovements, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { todayIso } from "@/lib/date";
import { getCardPurchaseInfo } from "@/features/loans/service";
import { checkCardRules } from "@/features/transactions/service";

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

/** ISO weekday (Mon=1..Sun=7) of a 'YYYY-MM-DD' string. */
function isoWeekdayOf(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7 + 1;
}

/** Every day of the month index whose ISO weekday matches. */
function weekdayDaysInMonth(monthIndex: number, isoWeekday: number): number[] {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: number[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    if (isoWeekdayOf(`${monthStartIso(monthIndex).slice(0, 7)}-${paddedDay(day)}`) === isoWeekday) {
      days.push(day);
    }
  }
  return days;
}

interface RecurringRow {
  frequency: "monthly" | "weekly" | "annual";
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
  // Weekly re-scans its open month on every catch-up (see header): the
  // replay is absorbed by the (recurring_id, date) unique index.
  if (row.frequency === "weekly") return true;
  return targetMonthFor(row, today) > baseMonthFor(row);
}

/**
 * Month indices still needing a row, oldest first. Monthly = every month
 * after the base; annual = the creation month's anniversary each year
 * (k ≥ 1, so the creation year itself never materializes; the pointer —
 * itself an anniversary — keeps the sequence aligned after catch-ups).
 */
function dueMonths(row: RecurringRow, today: string): number[] {
  const base = baseMonthFor(row);
  const target = targetMonthFor(row, today);
  const months: number[] = [];
  if (row.frequency === "annual") {
    const creation = monthIndexOfIso(`${todayIso(row.createdAt).slice(0, 7)}-01`);
    for (
      let k = Math.max(1, Math.ceil((base + 1 - creation) / 12));
      creation + 12 * k <= target;
      k++
    ) {
      months.push(creation + 12 * k);
    }
    return months;
  }
  for (let month = base + 1; month <= target; month++) months.push(month);
  return months;
}

/**
 * Weekly occurrence dates still due: every creation-weekday date from the
 * pointer month through the current one, after the creation day (base-day
 * rule) and up to today (nothing future-dated).
 */
function dueWeeklyDates(row: RecurringRow, today: string): string[] {
  const creationIso = todayIso(row.createdAt);
  const weekday = isoWeekdayOf(creationIso);
  const start = row.lastMaterializedMonth
    ? monthIndexOfIso(row.lastMaterializedMonth)
    : monthIndexOfIso(`${creationIso.slice(0, 7)}-01`);
  const end = monthIndexOfIso(`${today.slice(0, 7)}-01`);
  const dates: string[] = [];
  for (let month = start; month <= end; month++) {
    for (const day of weekdayDaysInMonth(month, weekday)) {
      const date = `${monthStartIso(month).slice(0, 7)}-${paddedDay(day)}`;
      if (date > creationIso && date <= today) dates.push(date);
    }
  }
  return dates;
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
      frequency: recurringMovements.frequency,
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

/** All due occurrences for ONE recurring, inside a single FOR UPDATE transaction. */
async function materializeOne(db: Database, id: string, today: string): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the row: concurrent view requests serialize here, so the loser
    // re-reads last_materialized_month after the winner committed and no-ops.
    // The joins only read isActive flags; the lock stays on THIS row.
    const [found] = await tx
      .select({
        recurring: recurringMovements,
        categoryActive: categories.isActive,
        memberActive: users.isActive,
      })
      .from(recurringMovements)
      .innerJoin(categories, eq(categories.id, recurringMovements.categoryId))
      .innerJoin(users, eq(users.id, recurringMovements.memberId))
      .where(eq(recurringMovements.id, id))
      .limit(1)
      .for("update", { of: recurringMovements });
    if (!found || !found.recurring.isActive) return 0;
    const row = found.recurring;
    if (!isPending(row, today)) return 0;

    // Occurrence dates + the pointer value this run advances to. Weekly
    // re-scans the open month (pointer = current month); monthly/annual
    // consume whole months (pointer = the day-gated target month).
    const dates =
      row.frequency === "weekly"
        ? dueWeeklyDates(row, today)
        : dueMonths(row, today).map(
            (month) => `${monthStartIso(month).slice(0, 7)}-${paddedDay(row.dayOfMonth)}`,
          );
    const advanceTo =
      row.frequency === "weekly"
        ? monthStartIso(monthIndexOfIso(`${today.slice(0, 7)}-01`))
        : monthStartIso(targetMonthFor(row, today));

    // FK RESTRICT blocks DELETING a referenced category/member, but not
    // DEACTIVATING them — and budgets only count active categories, so
    // materializing would create spend invisible to the budget. Skip the
    // inserts but advance the pointer anyway: no silent backfill if the
    // category/member is reactivated later.
    if (!found.categoryActive || !found.memberActive) {
      await tx
        .update(recurringMovements)
        .set({ lastMaterializedMonth: advanceTo })
        .where(eq(recurringMovements.id, id));
      return 0;
    }

    // Card-funded rows consume the card's cupo (same exported rule as the
    // movements service). A broken/exhausted card skips this batch but the
    // pointer still advances — same precedent as above.
    if (row.paymentMethod === "card") {
      // The 0016 CHECK guarantees card_loan_id is set when payment is card.
      const card = await getCardPurchaseInfo(tx, row.cardLoanId!);
      const cardError = card.ok
        ? checkCardRules(row.type, card, dates.length * row.amountCents)
        : "card_not_found";
      if (cardError) {
        await tx
          .update(recurringMovements)
          .set({ lastMaterializedMonth: advanceTo })
          .where(eq(recurringMovements.id, id));
        return 0;
      }
    }

    const values = dates.map((date) => ({
      date,
      amountCents: row.amountCents,
      type: row.type,
      categoryId: row.categoryId,
      memberId: row.memberId,
      scope: row.scope,
      note: row.name,
      needsDetails: false,
      recurringId: row.id,
      paymentMethod: row.paymentMethod,
      cardLoanId: row.paymentMethod === "card" ? row.cardLoanId : null,
    }));

    // The pointer update rides the SAME transaction: either both land or
    // neither does — a committed movement never replays (monthly/annual).
    // Weekly replays its open month on purpose; onConflictDoNothing turns
    // the replay into a no-op and .returning() counts the fresh rows.
    let insertedCount = 0;
    if (values.length > 0) {
      if (row.frequency === "weekly") {
        const fresh = await tx
          .insert(transactions)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: transactions.id });
        insertedCount = fresh.length;
      } else {
        await tx.insert(transactions).values(values);
        insertedCount = values.length;
      }
    }
    await tx
      .update(recurringMovements)
      .set({ lastMaterializedMonth: advanceTo })
      .where(eq(recurringMovements.id, id));
    return insertedCount;
  });
}
