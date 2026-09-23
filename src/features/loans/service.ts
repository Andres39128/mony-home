/**
 * Loans (debts) service — loan CRUD, payment ledger and net patrimony.
 *
 * Mirrors the savings architecture: pure-ish functions over the DB (no
 * Next.js imports) so they are testable against PGlite. Loan CRUD and
 * balance corrections are admin-only and take the calling SessionUser to
 * enforce the role at service level. Payments are open to any authenticated
 * member, always attributed to themselves unless an admin says otherwise
 * (movements rule 6). Amounts arrive as free text and ALWAYS go through
 * money.parseAmountToCents (R2).
 *
 * The OUTSTANDING balance is computed, never stored: principal + interest −
 * payments. A loan's proceeds create NO transaction (borrowed money is not
 * income); each PAYMENT mirrors one expense so the household stats reflect
 * the real money flow. Interest rows never mirror.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, loanPayments, loans, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import { parseAmountToCents } from "@/lib/money";
import { parseAmountCents } from "@/lib/money-errors";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/lib/date";
import { catchUpAllLoanInterest, catchUpInterest } from "./accrual";
// Pure math lives in a client-safe module; re-exported here so the service
// stays the single import surface for server-side callers and tests.
export { computeOutstanding, computePaidPct } from "./math";
import { computeOutstanding, computePaidPct } from "./math";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Validation (trust boundary)
// ---------------------------------------------------------------------------

/** Empty string = no rate. */
const optionalRate = z.union([z.string().trim(), z.literal("")]);

export const loanSchema = z
  .object({
    name: z.string().trim().min(1, "El nombre es obligatorio").max(64, "Máximo 64 caracteres"),
    kind: z.enum(["credit_card", "investment_line", "mortgage", "other"]),
    /** Lending entity — required (a debt always belongs to someone). */
    entity: z.string().trim().min(1, "La entidad es obligatoria").max(64, "Máximo 64 caracteres"),
    scope: z.enum(["individual", "common"]),
    /** Empty string = common loan without owner. */
    memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
    principal: z.string().trim().min(1, "El capital es obligatorio"),
    /** AR-tolerant annual percent ("35,5" = 35,5% TNA); empty string = no interest. */
    annualRate: optionalRate,
  })
  .refine((v) => v.scope !== "individual" || v.memberId !== "", {
    message: "Los préstamos individuales requieren un integrante.",
    path: ["memberId"],
  })
  .refine((v) => v.scope !== "common" || v.memberId === "", {
    message: "Los préstamos comunes no llevan integrante.",
    path: ["memberId"],
  });

export type LoanInput = z.output<typeof loanSchema>;

export const loanPaymentSchema = z.object({
  /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
  amount: z.string().trim().min(1, "El monto es obligatorio"),
  /** Empty string = today (quick-entry forms may omit the date). */
  date: z
    .union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")])
    .transform((v) => (v === "" ? todayIso() : v)),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
  /** Empty string = the acting user; admins may attribute to any member. */
  memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
});

export type LoanPaymentInput = z.output<typeof loanPaymentSchema>;

export const outstandingSchema = z
  .string()
  .trim()
  .min(1, "El saldo es obligatorio");

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface LoanView {
  id: string;
  name: string;
  kind: "credit_card" | "investment_line" | "mortgage" | "other";
  entity: string;
  scope: "individual" | "common";
  memberId: string | null;
  memberName: string | null;
  principalCents: number;
  /** Annual nominal rate in bp; null = no interest. */
  annualRateBp: number | null;
  isActive: boolean;
  /** Sum of 'payment' rows — what has been paid back so far. */
  paidCents: number;
  /** Sum of 'interest' rows — what the debt has generated so far. */
  interestCents: number;
  /** principal + interest − payments (computed, never stored). */
  outstandingCents: number;
  /** Share of the principal already paid (0..100+, 2 decimals). */
  paidPct: number;
  paymentCount: number;
}

export interface PaymentView {
  id: string;
  /** Owning loan — lets one query feed every card's collapsible history. */
  loanId: string;
  kind: "payment" | "interest";
  amountCents: number;
  date: string;
  note: string | null;
  /** null on interest rows (a charge belongs to the loan, not a member). */
  memberId: string | null;
  memberName: string | null;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export async function listLoans(db: Database): Promise<LoanView[]> {
  // Lazy catch-up first so every read path shows interest accrued up to now.
  await catchUpAllLoanInterest(db);

  const rows = await db
    .select({
      id: loans.id,
      name: loans.name,
      kind: loans.kind,
      entity: loans.entity,
      scope: loans.scope,
      memberId: loans.memberId,
      memberName: users.name,
      principalCents: loans.principalCents,
      annualRateBp: loans.annualRateBp,
      isActive: loans.isActive,
      paid: sql<string | null>`coalesce(sum(case when ${loanPayments.kind} = 'payment' then ${loanPayments.amountCents} else 0 end), 0)`,
      interest: sql<string | null>`coalesce(sum(case when ${loanPayments.kind} = 'interest' then ${loanPayments.amountCents} else 0 end), 0)`,
      paymentCount: sql<string | null>`count(${loanPayments.id})`,
    })
    .from(loans)
    .leftJoin(users, eq(loans.memberId, users.id))
    .leftJoin(loanPayments, eq(loanPayments.loanId, loans.id))
    .groupBy(loans.id, users.name)
    .orderBy(
      // Active first, then by name.
      sql`case when ${loans.isActive} then 0 else 1 end`,
      asc(loans.name),
    );

  return rows.map((row) => {
    const paidCents = Number(row.paid ?? 0);
    const interestCents = Number(row.interest ?? 0);
    return {
      ...row,
      memberName: row.memberName ?? null,
      paidCents,
      interestCents,
      outstandingCents: computeOutstanding(row.principalCents, interestCents, paidCents),
      paidPct: computePaidPct(row.principalCents, paidCents),
      paymentCount: Number(row.paymentCount ?? 0),
    };
  });
}

/** AR-tolerant free-text amount → cents, or null when unparseable. */
function parseLenientCents(amount: string): number | null {
  try {
    return parseAmountToCents(amount);
  } catch {
    return null;
  }
}

/**
 * AR-tolerant annual percent → basis points. Reuses the sanctioned money
 * parser: percent cents ARE basis points ("35,5" → 3550 bp, "70" → 7000).
 * Empty = null = no interest; caps at 1000% TNA (100000 bp).
 */
function parseOptionalRate(rate: string): { bp: number | null } | { error: "invalid_rate" } {
  if (rate === "") return { bp: null };
  let bp: number;
  try {
    bp = parseAmountToCents(rate);
  } catch {
    return { error: "invalid_rate" };
  }
  if (bp < 0 || bp > 100000) return { error: "invalid_rate" };
  return { bp };
}

function loanValues(input: LoanInput, principalCents: number, rateBp: number | null) {
  return {
    name: input.name,
    kind: input.kind,
    entity: input.entity,
    scope: input.scope,
    memberId: input.scope === "individual" ? input.memberId : null,
    principalCents,
    annualRateBp: rateBp,
  };
}

export type LoanResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_principal"
        | "invalid_rate"
        | "invalid_outstanding"
        | "member_not_found"
        | "loan_not_found"
        | "has_payments"
        | "forbidden";
    };

export async function createLoan(
  db: Database,
  user: SessionUser,
  input: LoanInput,
): Promise<LoanResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const principal = parseLenientCents(input.principal);
  if (principal === null || principal <= 0) return { ok: false, error: "invalid_principal" };
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: "invalid_rate" };

  try {
    await db.insert(loans).values(loanValues(input, principal, rate.bp));
    return { ok: true };
  } catch (error) {
    // Stale member option (deleted between render and submit).
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function updateLoan(
  db: Database,
  user: SessionUser,
  id: string,
  input: LoanInput,
): Promise<LoanResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const principal = parseLenientCents(input.principal);
  if (principal === null || principal <= 0) return { ok: false, error: "invalid_principal" };
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: "invalid_rate" };

  try {
    const updated = await db
      .update(loans)
      .set(loanValues(input, principal, rate.bp))
      .where(eq(loans.id, id))
      .returning({ id: loans.id });
    if (updated.length === 0) return { ok: false, error: "loan_not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function toggleLoanActive(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<LoanResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(loans)
    .set({ isActive: sql`not ${loans.isActive}` })
    .where(eq(loans.id, id))
    .returning({ id: loans.id });
  if (updated.length === 0) return { ok: false, error: "loan_not_found" };
  return { ok: true };
}

export async function removeLoan(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<LoanResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    const deleted = await db
      .delete(loans)
      .where(eq(loans.id, id))
      .returning({ id: loans.id });
    if (deleted.length === 0) return { ok: false, error: "loan_not_found" };
    return { ok: true };
  } catch (error) {
    // RESTRICT FK: loan_payments.loan_id (23001 on PGlite, 23503 on PG 17).
    if (hasPgFkError(error)) return { ok: false, error: "has_payments" };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_amount"
        | "ambiguous_amount"
        | "loan_not_found"
        | "loan_inactive"
        | "member_not_found"
        | "system_category_missing"
        | "forbidden";
    };

/** Member attribution: empty = the acting user; non-admins cannot target others. */
function resolveMemberId(
  user: SessionUser,
  memberId: string,
): { ok: true; memberId: string } | { ok: false; error: "forbidden" } {
  const resolved = memberId === "" ? user.id : memberId;
  if (user.role !== "admin" && resolved !== user.id) return { ok: false, error: "forbidden" };
  return { ok: true, memberId: resolved };
}

/**
 * System mirror category (seeded in BOTH modes): paying a loan is real
 * money leaving the household — an expense.
 */
const MIRROR_PAYMENT_CATEGORY = "Pago de préstamos";

/**
 * Registers a payment: one 'payment' ledger row plus ONE mirrored expense
 * transaction (same member, date, scope and amount as the payment, note
 * "Pago {loan.name}"), linked via transactions.loan_payment_id (CASCADE
 * delete). Both commit together (R1) so stats never diverge from the
 * ledger. Interest rows never pass through here.
 */
export async function addLoanPayment(
  db: Database,
  user: SessionUser,
  loanId: string,
  input: LoanPaymentInput,
): Promise<PaymentResult> {
  // Discriminated like movements: '1.234' asks for guidance instead of a
  // generic rejection (shared lib/money-errors surface).
  const cents = parseAmountCents(input.amount);
  if (cents === "ambiguous_amount") return { ok: false, error: "ambiguous_amount" };
  if (cents === "invalid_amount" || cents <= 0) return { ok: false, error: "invalid_amount" };

  return db.transaction(async (tx) => {
    const [loan] = await tx
      .select({ name: loans.name, scope: loans.scope, isActive: loans.isActive })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1);
    if (!loan) return { ok: false, error: "loan_not_found" };
    if (!loan.isActive) return { ok: false, error: "loan_inactive" };

    const member = resolveMemberId(user, input.memberId);
    if (!member.ok) return member;

    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, MIRROR_PAYMENT_CATEGORY))
      .limit(1);
    // Run `npm run db:seed` after deploying: both modes create it.
    if (!category) return { ok: false, error: "system_category_missing" };

    try {
      const [payment] = await tx
        .insert(loanPayments)
        .values({
          loanId,
          memberId: member.memberId,
          kind: "payment",
          amountCents: cents,
          date: input.date,
          note: input.note ? input.note : null,
        })
        .returning({ id: loanPayments.id });

      await tx.insert(transactions).values({
        date: input.date,
        amountCents: cents,
        type: "expense",
        categoryId: category.id,
        memberId: member.memberId,
        scope: loan.scope,
        note: `Pago ${loan.name}`,
        loanPaymentId: payment.id,
      });
      return { ok: true };
    } catch (error) {
      if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
      throw error;
    }
  });
}

/** Full history (optionally one loan's), newest first. Feeds the /prestamos cards. */
export async function listPayments(db: Database, loanId?: string): Promise<PaymentView[]> {
  return db
    .select({
      id: loanPayments.id,
      loanId: loanPayments.loanId,
      kind: loanPayments.kind,
      amountCents: loanPayments.amountCents,
      date: loanPayments.date,
      note: loanPayments.note,
      memberId: loanPayments.memberId,
      memberName: users.name,
    })
    .from(loanPayments)
    .leftJoin(users, eq(loanPayments.memberId, users.id))
    .where(loanId ? eq(loanPayments.loanId, loanId) : undefined)
    .orderBy(desc(loanPayments.date), desc(loanPayments.createdAt));
}

// ---------------------------------------------------------------------------
// Manual balance correction (admin true-up)
// ---------------------------------------------------------------------------

export type OutstandingResult =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_outstanding" | "loan_not_found" | "forbidden";
    };

/**
 * Admin-only manual correction: when the real statement differs from the
 * computed outstanding, the delta materializes as ONE visible 'interest'
 * row ("Ajuste de saldo") so the ledger stays the single source of truth.
 * Same-day adjustments are replaced (one net entry converging to the latest
 * stated balance) — the partial unique index requires it.
 */
export async function updateOutstanding(
  db: Database,
  user: SessionUser,
  loanId: string,
  newOutstanding: string,
): Promise<OutstandingResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  const cents = parseLenientCents(newOutstanding);
  if (cents === null || cents < 0) return { ok: false, error: "invalid_outstanding" };

  // Pre-check for typed errors; the mutations below re-check via the tx
  // (a loan deleted mid-flight simply updates zero rows).
  const [existing] = await db
    .select({ id: loans.id })
    .from(loans)
    .where(eq(loans.id, loanId))
    .limit(1);
  if (!existing) return { ok: false, error: "loan_not_found" };

  await db.transaction(async (tx) => {
    const [loan] = await tx
      .select({ principalCents: loans.principalCents })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1)
      .for("update");
    if (!loan) return;

    const today = todayIso();
    // Drop today's earlier adjustment first (same-day converge), then
    // recompute: repeated corrections converge to the latest stated value.
    await tx
      .delete(loanPayments)
      .where(
        and(
          eq(loanPayments.loanId, loanId),
          eq(loanPayments.kind, "interest"),
          eq(loanPayments.date, today),
          eq(loanPayments.note, "Ajuste de saldo"),
        ),
      );

    const [agg] = await tx
      .select({
        interest: sql<number>`coalesce(sum(case when ${loanPayments.kind} = 'interest' then ${loanPayments.amountCents} else 0 end), 0)`,
        paid: sql<number>`coalesce(sum(case when ${loanPayments.kind} = 'payment' then ${loanPayments.amountCents} else 0 end), 0)`,
      })
      .from(loanPayments)
      .where(eq(loanPayments.loanId, loanId));
    const outstanding = loan.principalCents + Number(agg?.interest ?? 0) - Number(agg?.paid ?? 0);

    const delta = cents - outstanding;
    if (delta !== 0) {
      await tx.insert(loanPayments).values({
        loanId,
        memberId: null,
        kind: "interest",
        amountCents: delta,
        date: today,
        note: "Ajuste de saldo",
      });
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Patrimony helper
// ---------------------------------------------------------------------------

/**
 * Total household debt across ALL loans (active or not — deactivating a
 * tracker does not forgive the debt): the sum of computed outstanding
 * balances. Runs the lazy catch-up first so charges are current.
 */
export async function getDebtCents(db: Database): Promise<number> {
  const loanRows = await listLoans(db);
  return loanRows.reduce((total, loan) => total + Math.max(loan.outstandingCents, 0), 0);
}

// Re-exported for the accrual engine's test surface and read-path callers.
export { catchUpInterest };
