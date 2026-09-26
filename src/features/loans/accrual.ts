/**
 * Lazy interest accrual for loans — TWO engines behind one mode fan-out.
 *
 * Both run on READ paths (listLoans → getPatrimony → /prestamos, dashboard
 * patrimony) — there is NO cron. `catchUpAllLoanInterest` selects
 * `amortization_mode` per loan and dispatches:
 *
 * - mode null (simple tracker): the ORIGINAL monthly engine below, byte for
 *   byte. Every elapsed WHOLE month materializes ONE 'interest' row dated
 *   the month start: round(outstanding_before × annual_rate_bp / 12 / 10000)
 *   on the declining balance.
 *
 * - mode 'bank': `catchUpBankInterest`, the savings/accrual.ts skeleton
 *   copied exactly (cold gate → FOR UPDATE tx → constant-note daily rows →
 *   batch insert → 23505 day-by-day savepoint replay). Every elapsed day
 *   materializes ONE 'interest' row over the RUNNING saldo (principal +
 *   prior interest + charges + mora − payments — the outstanding the whole
 *   feature computes):
 *       round(saldo × ((1 + chargedEA)^(1/365) − 1))   [divisor ALWAYS 365]
 *   Money moves (payments) earn from the day AFTER their date, bolsas rule.
 *
 *   At each `cuota_day` crossing the closing period materializes ONE
 *   note-keyed 'charge' row per configured component (null = off):
 *       vida     = round(period-start saldo / 1e6 × lifeRateX100k / 1e5)
 *       incendio = round(property_value_cents / 1e6 × fireRateX100k / 1e5)
 *       otros    = other_charges_cents
 *   The vida base is the RUNNING saldo when the period opened (never
 *   insured_base_cents — that column is display-only) and the charges join
 *   the saldo only AFTER the close. When a closed cuota's lines remain
 *   unpaid past the anchor, a daily "Mora" charge accrues over those lines
 *   (mora never earns mora); payments clear the overdue base first.
 *
 *   Rate edits are prospective: `charged_rate_bp` is read ONCE per pass
 *   inside the FOR UPDATE lock, inserted rows are immutable, and the
 *   rate-agnostic constant note makes a replayed day 23505-collide so the
 *   old-rate row survives (bolsas-identical mechanism).
 *
 * Idempotent under concurrency too: the whole catch-up runs in one
 * transaction holding the loan row FOR UPDATE, and the partial unique
 * (loan_id, date, note) WHERE kind IN ('interest','charge') backs the
 * invariant at the DB level — a racing request inserts nothing.
 *
 * ponytail: ~31 daily rows per period ⇒ ≈7.3k rows/loan at 240 months.
 * Past ~10k rows/loan a full catch-up pass gets sluggish — archive or
 * summarize old rows if reads ever show it.
 */
import { and, eq, isNotNull, max, or } from "drizzle-orm";
import { loanPayments, loans } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError } from "@/db/pg-errors";
import { formatRatePercent } from "@/features/savings/math";
import { dailyInterestCents, moraDailyCents } from "@/features/loans/amortization";
import { monthIndexOfDate, todayIso } from "@/lib/date";

/** Months since year 0 for a 'YYYY-MM-DD' string — comparable and add/subtract friendly. */
function monthIndexOfIso(iso: string): number {
  const [year, month] = iso.split("-").map(Number);
  return year * 12 + (month - 1);
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
 *
 * COLD GATE: the lock-free pre-check means steady-state reads open ZERO
 * write transactions — only loans with pending months pay for FOR UPDATE.
 */
export async function catchUpInterest(
  db: Database,
  loanId: string,
  now: Date = new Date(),
): Promise<number> {
  // Lock-free pre-check: not a rate-bearing loan, or no elapsed whole month.
  const [loan] = await db
    .select({
      annualRateBp: loans.annualRateBp,
      createdAt: loans.createdAt,
    })
    .from(loans)
    .where(eq(loans.id, loanId))
    .limit(1);
  if (!loan) return 0;
  if (loan.annualRateBp === null) return 0;
  if (monthIndexOfDate(now) <= (await baseMonthFor(db, loanId, loan.createdAt))) return 0;

  return db.transaction(async (tx) => {
    // Lock the loan row: concurrent view requests serialize here, so the
    // loser re-reads the base after the winner committed and no-ops.
    const [locked] = await tx
      .select({
        annualRateBp: loans.annualRateBp,
        principalCents: loans.principalCents,
        createdAt: loans.createdAt,
      })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1)
      .for("update");
    if (!locked) return 0;

    return accrueLoan(tx, loanId, locked as AccrualBase, now);
  });
}

/** Rate-bearing loans only — one indexed query when there are none. */
export async function catchUpAllLoanInterest(db: Database, now: Date = new Date()): Promise<void> {
  const rows = await db
    .select({ id: loans.id, amortizationMode: loans.amortizationMode })
    .from(loans)
    .where(or(isNotNull(loans.amortizationMode), isNotNull(loans.annualRateBp)));
  for (const row of rows) {
    if (row.amortizationMode === "bank") {
      await catchUpBankInterest(db, row.id, now);
    } else {
      await catchUpInterest(db, row.id, now);
    }
  }
}

/** Any Postgres drizzle database — the app pool in production, PGlite in tests. */
type AccrualDb = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Read-only view (pool OR open transaction) for the cheap base query. */
type AccrualReader = Pick<Database, "select">;

/** Accrual base month: latest interest month, or the loan creation month. */
async function baseMonthFor(
  db: AccrualReader,
  loanId: string,
  createdAt: Date,
): Promise<number> {
  const [last] = await db
    .select({ lastInterest: max(loanPayments.date) })
    .from(loanPayments)
    .where(and(eq(loanPayments.loanId, loanId), eq(loanPayments.kind, "interest")));
  return Math.max(
    monthIndexOfDate(createdAt),
    last?.lastInterest ? monthIndexOfIso(last.lastInterest) : 0,
  );
}

async function accrueLoan(
  db: AccrualDb,
  loanId: string,
  loan: AccrualBase,
  now: Date,
): Promise<number> {
  const rateBp = loan.annualRateBp;
  if (rateBp === null) return 0;

  const baseMonth = await baseMonthFor(db, loanId, loan.createdAt);
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

/* ────────────────────────── bank engine (mode 'bank') ────────────────── */

/** One visible ledger row per loan per day; constant note keeps the
 * (loan_id, date, note) partial unique index idempotent across rate edits. */
const BANK_DAILY_INTEREST_NOTE = "Interés diario";
const LIFE_INSURANCE_NOTE = "Seguro de vida";
const FIRE_INSURANCE_NOTE = "Seguro de incendio";
const OTHER_CHARGES_NOTE = "Otros cargos";
const MORA_NOTE = "Mora";

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

/**
 * Per-millón component charge in cents: round(baseCents / 1e6 × rateX100k / 1e5).
 * Divide BEFORE multiplying — bases and rates both reach 1e10+ and the
 * product would overflow float53 integer exactness.
 */
function perMillonChargeCents(baseCents: number, ratePerMillonX100k: number): number {
  return Math.round((baseCents / 1e6) * (ratePerMillonX100k / 1e5));
}

/** Latest cuota anchor (day-of-month == cuotaDay) on or before `dayIndex`,
 * as an ISO string — or null when it would predate the loan's creation. */
function previousAnchorIso(dayIndex: number, cuotaDay: number, createdIso: string): string | null {
  const iso = isoOfDayIndex(dayIndex);
  const [year, month, day] = iso.split("-").map(Number);
  const candidate =
    day >= cuotaDay
      ? `${year}-${String(month).padStart(2, "0")}-${String(cuotaDay).padStart(2, "0")}`
      : month > 1
        ? `${year}-${String(month - 1).padStart(2, "0")}-${String(cuotaDay).padStart(2, "0")}`
        : `${year - 1}-12-${String(cuotaDay).padStart(2, "0")}`;
  return candidate >= createdIso ? candidate : null;
}

/** Config locked with the loan row; the gate CHECK guarantees the four core
 * fields for mode 'bank', so chargedRateBp/cuotaDay are non-null here. */
interface BankAccrualBase {
  chargedRateBp: number;
  cuotaDay: number;
  principalCents: number;
  propertyValueCents: number | null;
  lifeInsuranceRatePerMillonX100k: number | null;
  fireInsuranceRatePerMillonX100k: number | null;
  otherChargesCents: number | null;
  moraRateBp: number | null;
  createdAt: Date;
}

/**
 * Brings one bank loan's daily accrual up to `now` (savings skeleton).
 * Returns the number of rows inserted (interest + charges + mora).
 *
 * COLD GATE: the lock-free pre-check means steady-state reads run two cheap
 * indexed SELECTs and open ZERO write transactions.
 */
export async function catchUpBankInterest(
  db: Database,
  loanId: string,
  now: Date = new Date(),
): Promise<number> {
  // Lock-free pre-check: not a bank loan, or no complete days since the
  // base → nothing to do (the write path re-checks under lock anyway).
  const [loan] = await db
    .select({
      amortizationMode: loans.amortizationMode,
      createdAt: loans.createdAt,
    })
    .from(loans)
    .where(eq(loans.id, loanId))
    .limit(1);
  if (!loan || loan.amortizationMode !== "bank") return 0;
  if (dayIndexOfIso(todayIso(now)) - 1 <= (await bankBaseDayFor(db, loanId, loan.createdAt))) {
    return 0;
  }

  return db.transaction(async (tx) => {
    // Lock the loan row: concurrent view requests serialize here, so the
    // loser re-reads the base after the winner committed and no-ops.
    const [locked] = await tx
      .select({
        amortizationMode: loans.amortizationMode,
        chargedRateBp: loans.chargedRateBp,
        cuotaDay: loans.cuotaDay,
        principalCents: loans.principalCents,
        propertyValueCents: loans.propertyValueCents,
        lifeInsuranceRatePerMillonX100k: loans.lifeInsuranceRatePerMillonX100k,
        fireInsuranceRatePerMillonX100k: loans.fireInsuranceRatePerMillonX100k,
        otherChargesCents: loans.otherChargesCents,
        moraRateBp: loans.moraRateBp,
        createdAt: loans.createdAt,
      })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1)
      .for("update");
    if (!locked || locked.amortizationMode !== "bank") return 0;

    return accrueBankLoan(tx, loanId, locked as BankAccrualBase, now);
  });
}

/** First-day base: day AFTER the strongest of creation day / last interest row. */
async function bankBaseDayFor(
  db: AccrualReader,
  loanId: string,
  createdAt: Date,
): Promise<number> {
  const [last] = await db
    .select({ lastInterest: max(loanPayments.date) })
    .from(loanPayments)
    .where(and(eq(loanPayments.loanId, loanId), eq(loanPayments.kind, "interest")));
  return Math.max(
    dayIndexOfDate(createdAt),
    last?.lastInterest ? dayIndexOfIso(last.lastInterest) : Number.NEGATIVE_INFINITY,
  );
}

async function accrueBankLoan(
  db: AccrualDb,
  loanId: string,
  loan: BankAccrualBase,
  now: Date,
): Promise<number> {
  // Rate read ONCE per pass, inside the lock — prospective edits (D3).
  const rateBp = loan.chargedRateBp;
  const createdIso = todayIso(loan.createdAt);
  const baseDay = await bankBaseDayFor(db, loanId, loan.createdAt);
  const yesterday = dayIndexOfIso(todayIso(now)) - 1;
  if (yesterday <= baseDay) return 0; // no complete days to accrue

  // Ledger rows feed the running saldo day by day (rows dated < earning
  // day form the base — money moves earn from the day AFTER their date).
  const rows = await db
    .select({
      kind: loanPayments.kind,
      amountCents: loanPayments.amountCents,
      date: loanPayments.date,
      note: loanPayments.note,
    })
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(loanPayments.date);

  // Reconstruct the pass state from rows already on disk: the running
  // saldo, the unpaid lines of CLOSED cuotas (mora base), the lines of the
  // currently open period, and the saldo the open period started from.
  const baseDayIso = isoOfDayIndex(baseDay);
  const prevAnchorIso = previousAnchorIso(baseDay, loan.cuotaDay, createdIso);
  let saldo = loan.principalCents;
  let anchorSaldo = loan.principalCents;
  let closedLines = 0;
  let openLines = 0;
  let paidCents = 0;
  for (const row of rows) {
    if (row.date > baseDayIso) break;
    const delta = row.kind === "payment" ? -row.amountCents : row.amountCents;
    saldo += delta;
    if (prevAnchorIso && row.date <= prevAnchorIso) anchorSaldo += delta;
    if (row.kind === "payment") {
      paidCents += row.amountCents;
    } else if (row.note !== MORA_NOTE) {
      if (prevAnchorIso && row.date <= prevAnchorIso) closedLines += row.amountCents;
      else openLines += row.amountCents;
    }
  }
  // Payments clear overdue lines first (oldest debt); mora rows never
  // re-earn and are cleared through the saldo like any other debt.
  let overdueLines = Math.max(0, closedLines - paidCents);
  let periodStartSaldo = prevAnchorIso ? anchorSaldo : saldo;

  // Build every day's row in JS (identical per-day Math.round math), then
  // write the whole window as ONE multi-row insert.
  const pending: (typeof loanPayments.$inferInsert)[] = [];
  let cursor = 0;
  while (cursor < rows.length && rows[cursor].date <= baseDayIso) cursor++;

  for (let day = baseDay + 1; day <= yesterday; day++) {
    const dayIso = isoOfDayIndex(day);
    while (cursor < rows.length && rows[cursor].date < dayIso) {
      applyBankRow(rows[cursor]);
      cursor++;
    }

    // The day's interest runs on the saldo BEFORE any same-date rows.
    const interestCents = dailyInterestCents(saldo, rateBp);
    if (interestCents > 0) {
      pushBankRow("interest", BANK_DAILY_INTEREST_NOTE, interestCents, dayIso);
      saldo += interestCents;
      openLines += interestCents;
    }

    if (Number(dayIso.slice(8, 10)) === loan.cuotaDay) {
      // Anchor: rows dated TODAY count for the close (a due-date payment
      // is on time) — drained after the interest so they still earn from
      // the next day, like every other money move.
      while (cursor < rows.length && rows[cursor].date === dayIso) {
        applyBankRow(rows[cursor]);
        cursor++;
      }
      const moraBase = overdueLines; // captured before today's close adds its lines

      const components: Array<[string, number]> = [];
      if (loan.lifeInsuranceRatePerMillonX100k !== null) {
        components.push([
          LIFE_INSURANCE_NOTE,
          perMillonChargeCents(periodStartSaldo, loan.lifeInsuranceRatePerMillonX100k),
        ]);
      }
      if (loan.fireInsuranceRatePerMillonX100k !== null && loan.propertyValueCents !== null) {
        components.push([
          FIRE_INSURANCE_NOTE,
          perMillonChargeCents(loan.propertyValueCents, loan.fireInsuranceRatePerMillonX100k),
        ]);
      }
      if (loan.otherChargesCents !== null) {
        components.push([OTHER_CHARGES_NOTE, loan.otherChargesCents]);
      }
      for (const [note, amountCents] of components) {
        if (amountCents > 0) {
          pushBankRow("charge", note, amountCents, dayIso);
          saldo += amountCents;
          openLines += amountCents;
        }
      }

      // The cuota closes: its lines become overdue debt until paid.
      overdueLines += openLines;
      openLines = 0;
      periodStartSaldo = saldo;

      if (loan.moraRateBp !== null && moraBase > 0) {
        const moraCents = moraDailyCents(moraBase, loan.moraRateBp);
        if (moraCents > 0) {
          pushBankRow("charge", MORA_NOTE, moraCents, dayIso);
          saldo += moraCents;
        }
      }
    } else if (loan.moraRateBp !== null && overdueLines > 0) {
      // Unpaid closed-cuota lines past the anchor accrue mora daily; the
      // mora row joins the saldo (interest-bearing debt) but never the
      // overdue base — mora does not earn mora.
      const moraCents = moraDailyCents(overdueLines, loan.moraRateBp);
      if (moraCents > 0) {
        pushBankRow("charge", MORA_NOTE, moraCents, dayIso);
        saldo += moraCents;
      }
    }
  }

  if (pending.length === 0) return 0;

  // Savepoint wrapper: the unique index backs the invariant even if a writer
  // bypassed the row lock. The savepoint is created BEFORE the statement, so
  // a 23505 rolls back to it and the outer transaction stays usable; the
  // day-by-day replay then keeps exactly one row per (date, note).
  try {
    await db.transaction(async (nested) => {
      await nested.insert(loanPayments).values(pending);
    });
  } catch (error) {
    if (!hasPgError(error, "23505")) throw error;
    for (const row of pending) {
      try {
        await db.transaction(async (nested) => {
          await nested.insert(loanPayments).values(row);
        });
      } catch (nestedError) {
        // Another writer already covered this day — keep what exists.
        if (!hasPgError(nestedError, "23505")) throw nestedError;
      }
    }
  }
  return pending.length;

  /** Apply one on-disk row to the running reconstruction. */
  function applyBankRow(row: { kind: string; amountCents: number; note: string | null }): void {
    if (row.kind === "payment") {
      saldo -= row.amountCents;
      overdueLines = Math.max(0, overdueLines - row.amountCents);
    } else {
      saldo += row.amountCents;
      if (row.note !== MORA_NOTE) openLines += row.amountCents;
    }
  }

  function pushBankRow(
    kind: "interest" | "charge",
    note: string,
    amountCents: number,
    date: string,
  ): void {
    pending.push({ loanId, memberId: null, kind, amountCents, date, note });
  }
}
