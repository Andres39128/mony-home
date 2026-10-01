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
 * the real money flow (card payments mirror their amortizing portion — the
 * purchase itself was card debt, not cash). Interest rows never mirror.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, loanPayments, loans, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import { parseAmountToCents } from "@/lib/money";
import { parseAmountCents } from "@/lib/money-errors";
import type { SessionUser } from "@/lib/auth";
import { dayIndexOfIso, isoOfDayIndex, todayIso } from "@/lib/date";
import { catchUpAllLoanInterest } from "./accrual";
import { FIRE_INSURANCE_NOTE, LIFE_INSURANCE_NOTE, MORA_NOTE } from "./accrual";
import { allocateWaterfall } from "./amortization";
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

/** Empty string = no amount / no number (bank calibration free-text fields). */
const optionalText = z.union([z.string().trim(), z.literal("")]);

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
    /** "" = simple tracker (monthly TNA engine); "bank" = bank-style engine; "revolving" = card. */
    amortizationMode: z.union([z.literal(""), z.literal("bank"), z.literal("revolving")]),
    /** Bank calibration (D4) — AR-formatted free text, parsed by the service. */
    chargedRate: optionalRate, // "12,95" % EA cobrada — THE accrual driver
    contractualRate: optionalRate, // "17,47" % pactada — display-only
    termMonths: optionalText, // "228"
    fixedCuota: optionalText, // "2.628.000,00"
    cuotaDay: optionalText, // "25" (1..28, February-safe)
    propertyValue: optionalText, // "339.802.600,00"
    insuredBase: optionalText, // display/calibration reference only
    lifeRatePerMillon: optionalText, // "471,32" pesos-per-millón
    fireRatePerMillon: optionalText, // "218,17" pesos-per-millón
    moraRate: optionalRate, // "36,5" % EA over unpaid overdue lines
    otherCharges: optionalText, // fixed "Otros cargos" per period
    /** Revolving config — AR free text, parsed by the service. */
    creditLimit: optionalText.default(""), // "5.000.000,00" cupo total
    managementFee: optionalText.default(""), // "25.000,00" cuota de manejo (0 or fixed)
    statementDay: optionalText.default(""), // "25" (1..28, February-safe)
  })
  .refine((v) => v.scope !== "individual" || v.memberId !== "", {
    message: "Los préstamos individuales requieren un integrante.",
    path: ["memberId"],
  })
  .refine((v) => v.scope !== "common" || v.memberId === "", {
    message: "Los préstamos comunes no llevan integrante.",
    path: ["memberId"],
  })
  // Mode gate (D1/R2): bank requires the four core config fields, each
  // reported on its own input so the form highlights what is missing…
  .refine((v) => v.amortizationMode !== "bank" || v.chargedRate !== "", {
    message: "La EA cobrada es obligatoria en modo bancario.",
    path: ["chargedRate"],
  })
  .refine((v) => v.amortizationMode !== "bank" || v.fixedCuota !== "", {
    message: "La cuota fija es obligatoria en modo bancario.",
    path: ["fixedCuota"],
  })
  .refine((v) => v.amortizationMode !== "bank" || v.termMonths !== "", {
    message: "El plazo es obligatorio en modo bancario.",
    path: ["termMonths"],
  })
  .refine((v) => v.amortizationMode !== "bank" || v.cuotaDay !== "", {
    message: "El día de cuota es obligatorio en modo bancario.",
    path: ["cuotaDay"],
  })
  // …revolving requires its cupo…
  .refine((v) => v.amortizationMode !== "revolving" || v.creditLimit !== "", {
    message: "El cupo es obligatorio en crédito rotativo.",
    path: ["creditLimit"],
  })
  // …and every mode excludes the other modes' config (mirrors the DB CHECKs):
  // revolving carries no rate (interest is manual at payment time)…
  .refine(
    (v) =>
      v.amortizationMode !== "revolving" ||
      (v.annualRate === "" &&
        [
          v.chargedRate,
          v.contractualRate,
          v.termMonths,
          v.fixedCuota,
          v.cuotaDay,
          v.propertyValue,
          v.insuredBase,
          v.lifeRatePerMillon,
          v.fireRatePerMillon,
          v.moraRate,
          v.otherCharges,
        ].every((field) => field === "")),
    {
      message: "Los campos bancarios y la tasa no aplican al crédito rotativo.",
      path: ["amortizationMode"],
    },
  )
  // …bank carries no revolving config…
  .refine(
    (v) =>
      v.amortizationMode !== "bank" ||
      [v.creditLimit, v.managementFee, v.statementDay].every((field) => field === ""),
    {
      message: "Los campos de crédito rotativo solo aplican al modo rotativo.",
      path: ["amortizationMode"],
    },
  )
  // …and a simple tracker carries no engine config at all.
  .refine(
    (v) =>
      v.amortizationMode !== "" ||
      [
        v.chargedRate,
        v.contractualRate,
        v.termMonths,
        v.fixedCuota,
        v.cuotaDay,
        v.propertyValue,
        v.insuredBase,
        v.lifeRatePerMillon,
        v.fireRatePerMillon,
        v.moraRate,
        v.otherCharges,
        v.creditLimit,
        v.managementFee,
        v.statementDay,
      ].every((field) => field === ""),
    {
      message: "Los campos bancarios solo aplican al modo bancario.",
      path: ["amortizationMode"],
    },
  );

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

/**
 * Card payment: the TOTAL amount paid plus the manual revolving extras —
 * variable interest (asked at payment time) and the fixed cuota de manejo
 * (checkbox, prefilled from the card config).
 */
export const cardPaymentSchema = z.object({
  /** Free-text AR-formatted total paid ("1.234,56"); parsed to cents by the service. */
  amount: z.string().trim().min(1, "El monto es obligatorio"),
  /** "¿Generó intereses?" — AR-formatted interest amount; empty = none. */
  interest: optionalText,
  /** Checkbox "incluir cuota de manejo": "1" = include the card's fixed fee. */
  includeFee: z.union([z.literal("1"), z.literal("")]).default(""),
  date: z
    .union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")])
    .transform((v) => (v === "" ? todayIso() : v)),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
  /** Empty string = the acting user; admins may attribute to any member. */
  memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
});

export type CardPaymentInput = z.output<typeof cardPaymentSchema>;

export const outstandingSchema = z
  .string()
  .trim()
  .min(1, "El saldo es obligatorio");

// ---------------------------------------------------------------------------
// Shared cupo math (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Ledger aggregates shared by listLoans and getCardPurchaseInfo — the
 * outstanding/available formula must live in ONE place (no duplicated SQL).
 */
const PURCHASES_SUM = sql<string | null>`(select coalesce(sum(${transactions.amountCents}), 0) from ${transactions} where ${transactions.cardLoanId} = ${loans.id} and ${transactions.needsDetails} = false)`;
const PAID_SUM = sql<string | null>`coalesce(sum(case when ${loanPayments.kind} = 'payment' then ${loanPayments.amountCents} else 0 end), 0)`;
const INTEREST_SUM = sql<string | null>`coalesce(sum(case when ${loanPayments.kind} = 'interest' then ${loanPayments.amountCents} else 0 end), 0)`;
const CHARGES_SUM = sql<string | null>`coalesce(sum(case when ${loanPayments.kind} = 'charge' then ${loanPayments.amountCents} else 0 end), 0)`;

/**
 * Revolving outstanding + cupo disponible (pure). Outstanding adds the card
 * purchases to the fixed-loan formula; available clamps to [0, limit] so a
 * saldo a favor never frees credit beyond the cupo.
 */
export function revolvingCardMath(
  principalCents: number,
  purchasesCents: number,
  interestCents: number,
  chargesCents: number,
  paidCents: number,
  creditLimitCents: number | null,
): { outstandingCents: number; availableCents: number | null } {
  const outstandingCents = computeOutstanding(
    principalCents + purchasesCents,
    interestCents + chargesCents,
    paidCents,
  );
  return {
    outstandingCents,
    availableCents:
      creditLimitCents !== null
        ? Math.max(0, Math.min(creditLimitCents, creditLimitCents - outstandingCents))
        : null,
  };
}

/**
 * Card facts a card-purchase validation needs: whether the target loan is an
 * active revolving card and how much cupo is left. The transactions service
 * calls this inside its own write transaction (rule checks + insert share
 * one TOCTOU-safe unit).
 */
export type CardPurchaseInfo =
  | { ok: false; error: "card_not_found" }
  | {
      ok: true;
      isActive: boolean;
      isRevolving: boolean;
      /** Cupo disponible; null when the loan is not a revolving card. */
      availableCents: number | null;
    };

export async function getCardPurchaseInfo(
  db: Pick<Database, "select">,
  cardId: string,
): Promise<CardPurchaseInfo> {
  const [row] = await db
    .select({
      isActive: loans.isActive,
      amortizationMode: loans.amortizationMode,
      creditLimitCents: loans.creditLimitCents,
      principalCents: loans.principalCents,
      purchases: PURCHASES_SUM,
      paid: PAID_SUM,
      interest: INTEREST_SUM,
      charges: CHARGES_SUM,
    })
    .from(loans)
    .leftJoin(loanPayments, eq(loanPayments.loanId, loans.id))
    .where(eq(loans.id, cardId))
    .groupBy(loans.id);
  if (!row) return { ok: false, error: "card_not_found" };
  const isRevolving = row.amortizationMode === "revolving";
  const { availableCents } = isRevolving
    ? revolvingCardMath(
        row.principalCents,
        Number(row.purchases ?? 0),
        Number(row.interest ?? 0),
        Number(row.charges ?? 0),
        Number(row.paid ?? 0),
        row.creditLimitCents,
      )
    : { availableCents: null };
  return { ok: true, isActive: row.isActive, isRevolving, availableCents };
}

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
  /** Sum of 'charge' rows — bank cuota components (seguros, cargos, mora). */
  chargesCents: number;
  /** principal + interest + charges − payments (computed, never stored). */
  outstandingCents: number;
  /** Share of the principal already paid (0..100+, 2 decimals). */
  paidPct: number;
  paymentCount: number;
  /** Engine mode block — null = simple tracker, 'bank'/'revolving' = engine config. */
  amortizationMode: "bank" | "revolving" | null;
  chargedRateBp: number | null;
  contractualRateBp: number | null;
  termMonths: number | null;
  fixedCuotaCents: number | null;
  cuotaDay: number | null;
  propertyValueCents: number | null;
  insuredBaseCents: number | null;
  lifeInsuranceRatePerMillonX100k: number | null;
  fireInsuranceRatePerMillonX100k: number | null;
  otherChargesCents: number | null;
  moraRateBp: number | null;
  /** Revolving block — null on every other mode. */
  creditLimitCents: number | null;
  managementFeeCents: number | null;
  statementDay: number | null;
  /** Sum of card purchases (linked transactions) — null on non-revolving. */
  purchasesCents: number | null;
  /**
   * Cupo disponible = limit − outstanding, clamped to [0, limit] — the
   * available credit a card purchase may consume; null on non-revolving.
   */
  availableCents: number | null;
}

export interface PaymentView {
  id: string;
  /** Owning loan — lets one query feed every card's collapsible history. */
  loanId: string;
  /** 'charge' rows are bank-style cuota components (seguros, otros cargos, mora). */
  kind: "payment" | "interest" | "charge";
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
      amortizationMode: loans.amortizationMode,
      chargedRateBp: loans.chargedRateBp,
      contractualRateBp: loans.contractualRateBp,
      termMonths: loans.termMonths,
      fixedCuotaCents: loans.fixedCuotaCents,
      cuotaDay: loans.cuotaDay,
      propertyValueCents: loans.propertyValueCents,
      insuredBaseCents: loans.insuredBaseCents,
      lifeInsuranceRatePerMillonX100k: loans.lifeInsuranceRatePerMillonX100k,
      fireInsuranceRatePerMillonX100k: loans.fireInsuranceRatePerMillonX100k,
      otherChargesCents: loans.otherChargesCents,
      moraRateBp: loans.moraRateBp,
      creditLimitCents: loans.creditLimitCents,
      managementFeeCents: loans.managementFeeCents,
      statementDay: loans.statementDay,
      purchases: PURCHASES_SUM,
      paid: PAID_SUM,
      interest: INTEREST_SUM,
      // Unpaid bank cuota components are debt too (D5).
      charges: CHARGES_SUM,
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
    const chargesCents = Number(row.charges ?? 0);
    const revolving = row.amortizationMode === "revolving";
    // Revolving debt includes the card purchases (they live in transactions,
    // not in this ledger); the shared helper owns the formula and the clamp.
    const purchasesCents = revolving ? Number(row.purchases ?? 0) : 0;
    const { outstandingCents, availableCents } = revolvingCardMath(
      row.principalCents,
      purchasesCents,
      interestCents,
      chargesCents,
      paidCents,
      revolving ? row.creditLimitCents : null,
    );
    return {
      ...row,
      memberName: row.memberName ?? null,
      paidCents,
      interestCents,
      chargesCents,
      purchasesCents: revolving ? purchasesCents : null,
      outstandingCents,
      availableCents: revolving ? availableCents : null,
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

/** Bank calibration form fields that can carry a typed error (D4). */
export type BankConfigField =
  | "chargedRate"
  | "contractualRate"
  | "termMonths"
  | "fixedCuota"
  | "cuotaDay"
  | "propertyValue"
  | "insuredBase"
  | "lifeRatePerMillon"
  | "fireRatePerMillon"
  | "moraRate"
  | "otherCharges";

/** Parsed bank columns for the loans table (all null on simple mode). */
type BankColumnValues = {
  amortizationMode: "bank" | null;
  chargedRateBp: number | null;
  contractualRateBp: number | null;
  termMonths: number | null;
  fixedCuotaCents: number | null;
  cuotaDay: number | null;
  propertyValueCents: number | null;
  insuredBaseCents: number | null;
  lifeInsuranceRatePerMillonX100k: number | null;
  fireInsuranceRatePerMillonX100k: number | null;
  otherChargesCents: number | null;
  moraRateBp: number | null;
};

/** Revolving form fields that can carry a typed error. */
export type RevolvingConfigField = "creditLimit" | "managementFee" | "statementDay";

/** Parsed revolving columns (all null unless mode is 'revolving'). */
type RevolvingColumnValues = {
  creditLimitCents: number | null;
  managementFeeCents: number | null;
  statementDay: number | null;
};

const NULL_BANK: BankColumnValues = {
  amortizationMode: null,
  chargedRateBp: null,
  contractualRateBp: null,
  termMonths: null,
  fixedCuotaCents: null,
  cuotaDay: null,
  propertyValueCents: null,
  insuredBaseCents: null,
  lifeInsuranceRatePerMillonX100k: null,
  fireInsuranceRatePerMillonX100k: null,
  otherChargesCents: null,
  moraRateBp: null,
};

const NULL_REVOLVING: RevolvingColumnValues = {
  creditLimitCents: null,
  managementFeeCents: null,
  statementDay: null,
};

/**
 * Parses the bank calibration block (D4). Per-millón rates go through the
 * sanctioned money parser × 1000 ("467,90" → 46790 cents → 46.790.000 on
 * the ×100.000 basis documented in the schema). Returns the failing field
 * instead of throwing so the caller maps it to a typed form error.
 */
function parseBankConfig(
  input: LoanInput,
): { ok: true; values: BankColumnValues } | { ok: false; field: BankConfigField } {
  if (input.amortizationMode !== "bank") {
    return { ok: true, values: NULL_BANK };
  }

  /** AR amount → non-negative cents (positive when required); null = invalid. */
  const amountCents = (text: string, positive = false): number | null => {
    const value = parseLenientCents(text);
    if (value === null || value < 0 || (positive && value <= 0)) return null;
    return value;
  };
  /** Per-millón "471,32" → 47132 cents × 1000 (the ×100.000 column basis). */
  const perMillonX100k = (text: string): number | null => {
    const value = amountCents(text);
    if (value === null || value * 1000 > 999_999_999) return null;
    return value * 1000;
  };
  /** Optional field: "" stays null, anything else must parse. */
  const optional = <T>(text: string, parse: () => T | null): T | null =>
    text === "" ? null : parse();

  const termMonths = Number.parseInt(input.termMonths, 10);
  if (!Number.isInteger(termMonths) || termMonths < 1) return { ok: false, field: "termMonths" };
  const cuotaDay = Number.parseInt(input.cuotaDay, 10);
  if (!Number.isInteger(cuotaDay) || cuotaDay < 1 || cuotaDay > 28) {
    return { ok: false, field: "cuotaDay" };
  }
  // Core fields (the gate CHECK requires all four).
  const charged = parseOptionalRate(input.chargedRate);
  if ("error" in charged || charged.bp === null) return { ok: false, field: "chargedRate" };
  const chargedRateBp = charged.bp;
  const fixedCuotaCents = amountCents(input.fixedCuota, true);
  if (fixedCuotaCents === null) return { ok: false, field: "fixedCuota" };

  const contractual = parseOptionalRate(input.contractualRate);
  if ("error" in contractual) return { ok: false, field: "contractualRate" };
  const contractualRateBp = contractual.bp;
  const mora = parseOptionalRate(input.moraRate);
  if ("error" in mora) return { ok: false, field: "moraRate" };
  const moraRateBp = mora.bp;
  const propertyValueCents = optional(input.propertyValue, () => amountCents(input.propertyValue));
  if (input.propertyValue !== "" && propertyValueCents === null) {
    return { ok: false, field: "propertyValue" };
  }
  const insuredBaseCents = optional(input.insuredBase, () => amountCents(input.insuredBase));
  if (input.insuredBase !== "" && insuredBaseCents === null) {
    return { ok: false, field: "insuredBase" };
  }
  const otherChargesCents = optional(input.otherCharges, () => amountCents(input.otherCharges));
  if (input.otherCharges !== "" && otherChargesCents === null) {
    return { ok: false, field: "otherCharges" };
  }
  const lifeX100k = optional(input.lifeRatePerMillon, () => perMillonX100k(input.lifeRatePerMillon));
  if (input.lifeRatePerMillon !== "" && lifeX100k === null) {
    return { ok: false, field: "lifeRatePerMillon" };
  }
  const fireX100k = optional(input.fireRatePerMillon, () => perMillonX100k(input.fireRatePerMillon));
  if (input.fireRatePerMillon !== "" && fireX100k === null) {
    return { ok: false, field: "fireRatePerMillon" };
  }

  return {
    ok: true,
    values: {
      amortizationMode: "bank",
      chargedRateBp,
      contractualRateBp,
      termMonths,
      fixedCuotaCents,
      cuotaDay,
      propertyValueCents,
      insuredBaseCents,
      lifeInsuranceRatePerMillonX100k: lifeX100k,
      fireInsuranceRatePerMillonX100k: fireX100k,
      otherChargesCents,
      moraRateBp,
    },
  };
}

/**
 * Parses the revolving block: cupo required and positive; cuota de manejo
 * optional and non-negative (0 = sin cuota); statement day optional 1..28.
 * Returns the failing field instead of throwing so the caller maps it to a
 * typed form error (same shape as parseBankConfig).
 */
function parseRevolvingConfig(
  input: LoanInput,
): { ok: true; values: RevolvingColumnValues } | { ok: false; field: RevolvingConfigField } {
  if (input.amortizationMode !== "revolving") {
    return { ok: true, values: NULL_REVOLVING };
  }

  const creditLimitCents = parseLenientCents(input.creditLimit);
  if (creditLimitCents === null || creditLimitCents <= 0) {
    return { ok: false, field: "creditLimit" };
  }

  let managementFeeCents: number | null = null;
  if (input.managementFee !== "") {
    managementFeeCents = parseLenientCents(input.managementFee);
    if (managementFeeCents === null || managementFeeCents < 0) {
      return { ok: false, field: "managementFee" };
    }
  }

  let statementDay: number | null = null;
  if (input.statementDay !== "") {
    statementDay = Number.parseInt(input.statementDay, 10);
    if (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 28) {
      return { ok: false, field: "statementDay" };
    }
  }

  return { ok: true, values: { creditLimitCents, managementFeeCents, statementDay } };
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
    }
  | { ok: false; error: "invalid_bank_config"; field: BankConfigField }
  | { ok: false; error: "invalid_revolving_config"; field: RevolvingConfigField };

/** Full insert/update values, or the typed mode-config field error. */
function tryLoanValues(input: LoanInput, principalCents: number, rateBp: number | null) {
  const bank = parseBankConfig(input);
  if (!bank.ok) return { ok: false as const, error: "invalid_bank_config" as const, field: bank.field };
  const revolving = parseRevolvingConfig(input);
  if (!revolving.ok) {
    return { ok: false as const, error: "invalid_revolving_config" as const, field: revolving.field };
  }
  return {
    ok: true as const,
    values: {
      ...loanValues(input, principalCents, rateBp),
      ...bank.values,
      ...revolving.values,
      // The mode itself comes from the input (NULL_BANK nulls it for
      // non-bank modes; revolving must survive the spread).
      amortizationMode: input.amortizationMode === "" ? null : input.amortizationMode,
    },
  };
}

export async function createLoan(
  db: Database,
  user: SessionUser,
  input: LoanInput,
): Promise<LoanResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  // Revolving cards may start at zero borrowed (the cupo is the commitment).
  const principal = parseLenientCents(input.principal);
  if (
    principal === null ||
    principal < 0 ||
    (principal === 0 && input.amortizationMode !== "revolving")
  ) {
    return { ok: false, error: "invalid_principal" };
  }
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: "invalid_rate" };
  const bank = tryLoanValues(input, principal, rate.bp);
  if (!bank.ok) return bank;

  try {
    await db.insert(loans).values(bank.values);
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
  if (
    principal === null ||
    principal < 0 ||
    (principal === 0 && input.amortizationMode !== "revolving")
  ) {
    return { ok: false, error: "invalid_principal" };
  }
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: "invalid_rate" };
  const bank = tryLoanValues(input, principal, rate.bp);
  if (!bank.ok) return bank;

  try {
    const updated = await db
      .update(loans)
      .set(bank.values)
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
 * System mirror category for the amortizing portion of a revolving card
 * payment (seeded in BOTH modes): the purchase was card debt (it never hit
 * the cash saldo), so paying the card is the real cash outflow.
 */
const MIRROR_CARD_PAYMENT_CATEGORY = "Pago de tarjetas";

/**
 * System mirror categories for revolving finance costs (seeded in BOTH
 * modes): card interest and the cuota de manejo are real cash the bank
 * took at payment time. The amortizing capital mirrors separately under
 * "Pago de tarjetas" — the three together add up to the total paid.
 */
const MIRROR_CARD_INTEREST_CATEGORY = "Intereses de tarjetas";
const MIRROR_CARD_FEE_CATEGORY = "Cuota de manejo de tarjetas";

/** Note-keys for the manual revolving engine rows (stable: the partial
 * unique index on (loan_id, date, note) keys idempotency off them). */
export const CARD_INTEREST_NOTE = "Interés de ciclo";
export const CARD_FEE_NOTE = "Cuota de manejo";

/** The transaction callback's client — shared by the mirror helpers. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Inserts the expense transaction mirrored from ONE ledger row, linked via
 * transactions.loan_payment_id (CASCADE delete keeps stats and ledger in
 * lockstep). Shared by loan payments, card payment capital, card interest
 * and card fee mirrors.
 */
async function insertMirrorExpense(
  tx: Tx,
  values: {
    date: string;
    amountCents: number;
    categoryId: string;
    memberId: string;
    scope: "individual" | "common";
    note: string;
    ledgerRowId: string;
  },
): Promise<void> {
  await tx.insert(transactions).values({
    date: values.date,
    amountCents: values.amountCents,
    type: "expense",
    categoryId: values.categoryId,
    memberId: values.memberId,
    scope: values.scope,
    note: values.note,
    loanPaymentId: values.ledgerRowId,
  });
}

/**
 * Inserts a note-keyed engine row ('interest'/'charge', member-less),
 * retrying with a " (n)" note suffix when the same loan/day/note already
 * exists (partial unique index) — two same-day card payments with interest
 * stay fluid instead of surfacing a raw 23505. Each attempt runs in a
 * NESTED transaction (a savepoint): the collision rolls back only the
 * failed insert, keeping the surrounding payment transaction usable
 * (same mechanism as the accrual engine's replay).
 */
async function insertEngineRow(
  tx: Tx,
  values: {
    loanId: string;
    kind: "interest" | "charge";
    amountCents: number;
    date: string;
    note: string;
  },
): Promise<{ id: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tx.transaction(async (nested) => {
        const [row] = await nested
          .insert(loanPayments)
          .values({ ...values, note: attempt === 1 ? values.note : `${values.note} (${attempt})` })
          .returning({ id: loanPayments.id });
        return row;
      });
    } catch (error) {
      if (attempt < 20 && hasPgError(error, "23505")) continue;
      throw error;
    }
  }
}

/** Looks up a system mirror category by name; null when the seed has not run. */
async function findMirrorCategoryId(tx: Tx, name: string): Promise<string | null> {
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name))
    .limit(1);
  return category?.id ?? null;
}

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

    const categoryId = await findMirrorCategoryId(tx, MIRROR_PAYMENT_CATEGORY);
    // Run `npm run db:seed` after deploying: both modes create it.
    if (!categoryId) return { ok: false, error: "system_category_missing" };

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

      await insertMirrorExpense(tx, {
        date: input.date,
        amountCents: cents,
        categoryId,
        memberId: member.memberId,
        scope: loan.scope,
        note: `Pago ${loan.name}`,
        ledgerRowId: payment.id,
      });
      return { ok: true };
    } catch (error) {
      if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
      throw error;
    }
  });
}

export type CardPaymentResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_amount"
        | "ambiguous_amount"
        | "invalid_interest"
        | "loan_not_found"
        | "loan_inactive"
        | "loan_not_revolving"
        | "fee_not_available"
        | "member_not_found"
        | "system_category_missing"
        | "forbidden";
    };

/**
 * Registers a card payment on a REVOLVING loan. The purchase was card debt
 * (it never reduced the cash saldo), so the payment is the real cash
 * outflow: its amortizing portion (total − interest − cuota de manejo)
 * mirrors ONE cash expense under "Pago de tarjetas", linked via
 * transactions.loan_payment_id (CASCADE delete). Overpayment mirrors the
 * same formula — the cash left the household regardless. The finance costs
 * mirror separately: the manually-entered interest and the included cuota
 * de manejo become 'interest'/'charge' engine rows, each with its own
 * expense mirror (the three mirrors add up to the total paid).
 *
 * Outstanding effect: +interest +fee −total converges to the statement
 * (paying the interest portion does not reduce capital).
 */
export async function addCardPayment(
  db: Database,
  user: SessionUser,
  loanId: string,
  input: CardPaymentInput,
): Promise<CardPaymentResult> {
  const cents = parseAmountCents(input.amount);
  if (cents === "ambiguous_amount") return { ok: false, error: "ambiguous_amount" };
  if (cents === "invalid_amount" || cents <= 0) return { ok: false, error: "invalid_amount" };

  let interestCents = 0;
  if (input.interest !== "") {
    const parsed = parseAmountCents(input.interest);
    if (parsed === "invalid_amount" || parsed === "ambiguous_amount" || parsed <= 0) {
      return { ok: false, error: "invalid_interest" };
    }
    interestCents = parsed;
  }

  return db.transaction(async (tx) => {
    const [loan] = await tx
      .select({
        name: loans.name,
        scope: loans.scope,
        isActive: loans.isActive,
        amortizationMode: loans.amortizationMode,
        managementFeeCents: loans.managementFeeCents,
      })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1);
    if (!loan) return { ok: false, error: "loan_not_found" };
    if (!loan.isActive) return { ok: false, error: "loan_inactive" };
    if (loan.amortizationMode !== "revolving") {
      return { ok: false, error: "loan_not_revolving" };
    }

    const member = resolveMemberId(user, input.memberId);
    if (!member.ok) return member;

    let feeCents = 0;
    if (input.includeFee === "1") {
      if (!loan.managementFeeCents || loan.managementFeeCents <= 0) {
        return { ok: false, error: "fee_not_available" };
      }
      feeCents = loan.managementFeeCents;
    }

    // The amortizing portion is the cash that used to be card debt: total
    // paid minus the finance costs (which mirror on their own rows). Zero
    // (all-finance payment) inserts no row — and needs no category (R3-001).
    const capitalCents = Math.max(cents - interestCents - feeCents, 0);

    // Mirror categories: required only when the corresponding row will
    // actually be written (capital > 0, or a finance cost riding along).
    const paymentCategoryId =
      capitalCents > 0 ? await findMirrorCategoryId(tx, MIRROR_CARD_PAYMENT_CATEGORY) : null;
    const interestCategoryId =
      interestCents > 0 ? await findMirrorCategoryId(tx, MIRROR_CARD_INTEREST_CATEGORY) : null;
    const feeCategoryId =
      feeCents > 0 ? await findMirrorCategoryId(tx, MIRROR_CARD_FEE_CATEGORY) : null;
    if (
      (capitalCents > 0 && !paymentCategoryId) ||
      (interestCents > 0 && !interestCategoryId) ||
      (feeCents > 0 && !feeCategoryId)
    ) {
      return { ok: false, error: "system_category_missing" };
    }

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

      // The amortizing portion is computed above (before the category
      // checks): zero inserts no row — never a 0-cent expense.
      if (capitalCents > 0) {
        await insertMirrorExpense(tx, {
          date: input.date,
          amountCents: capitalCents,
          categoryId: paymentCategoryId!,
          memberId: member.memberId,
          scope: loan.scope,
          note: `Pago ${loan.name}`,
          ledgerRowId: payment.id,
        });
      }

      if (interestCents > 0) {
        const row = await insertEngineRow(tx, {
          loanId,
          kind: "interest",
          amountCents: interestCents,
          date: input.date,
          note: CARD_INTEREST_NOTE,
        });
        await insertMirrorExpense(tx, {
          date: input.date,
          amountCents: interestCents,
          categoryId: interestCategoryId!,
          memberId: member.memberId,
          scope: loan.scope,
          note: `Interés ${loan.name}`,
          ledgerRowId: row.id,
        });
      }

      if (feeCents > 0) {
        const row = await insertEngineRow(tx, {
          loanId,
          kind: "charge",
          amountCents: feeCents,
          date: input.date,
          note: CARD_FEE_NOTE,
        });
        await insertMirrorExpense(tx, {
          date: input.date,
          amountCents: feeCents,
          categoryId: feeCategoryId!,
          memberId: member.memberId,
          scope: loan.scope,
          note: `Cuota de manejo ${loan.name}`,
          ledgerRowId: row.id,
        });
      }
      return { ok: true };
    } catch (error) {
      if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
      throw error;
    }
  });
}

export type LedgerEntryResult =
  | { ok: true }
  | { ok: false; error: "entry_not_found" | "forbidden" };

/**
 * Admin-only error correction: deletes one loan_payments row (a wrong
 * payment, interest or charge). Mirrored expense transactions fall with it
 * via transactions.loan_payment_id ON DELETE CASCADE — the correction
 * leaves no orphan stats behind.
 */
export async function removeLedgerEntry(
  db: Database,
  user: SessionUser,
  entryId: string,
): Promise<LedgerEntryResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const deleted = await db
    .delete(loanPayments)
    .where(eq(loanPayments.id, entryId))
    .returning({ id: loanPayments.id });
  if (deleted.length === 0) return { ok: false, error: "entry_not_found" };
  return { ok: true };
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
  now: Date = new Date(),
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
      .select({
        amortizationMode: loans.amortizationMode,
        principalCents: loans.principalCents,
      })
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1)
      .for("update");
    if (!loan) return;

    // Injectable clock (same pattern as listCardCycles): the true-up date
    // decides which accrual day runs on the rebased saldo — tests inject a
    // fixed date so the same-day ordering never depends on the real today.
    const today = todayIso(now);
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
        // Unpaid bank cuota components are debt (D5): the true-up converges
        // to the stated saldo INCLUDING the charges.
        charges: sql<number>`coalesce(sum(case when ${loanPayments.kind} = 'charge' then ${loanPayments.amountCents} else 0 end), 0)`,
        paid: sql<number>`coalesce(sum(case when ${loanPayments.kind} = 'payment' then ${loanPayments.amountCents} else 0 end), 0)`,
      })
      .from(loanPayments)
      .where(eq(loanPayments.loanId, loanId));

    // Revolving debt includes the card purchases (they live in transactions);
    // without them the true-up would converge to a purchases-less balance.
    let purchases = 0;
    if (loan.amortizationMode === "revolving") {
      const [purchaseAgg] = await tx
        .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
        .from(transactions)
        .where(
          and(eq(transactions.cardLoanId, loanId), eq(transactions.needsDetails, false)),
        );
      purchases = Number(purchaseAgg?.total ?? 0);
    }

    const outstanding =
      loan.principalCents +
      purchases +
      Number(agg?.interest ?? 0) +
      Number(agg?.charges ?? 0) -
      Number(agg?.paid ?? 0);

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

// ---------------------------------------------------------------------------
// Bank period statement (D5)
// ---------------------------------------------------------------------------

/** The five Davivienda statement sections for one closed cuota period. */
export interface LoanPeriodSections {
  /** "Seguro de vida" + "Seguro de incendio" (note-keyed charge rows). */
  segurosCents: number;
  /** "Otros cargos" charge rows (and any unrecognized charge note). */
  otrosCargosCents: number;
  /** "Mora" charge rows — its own section, never inside the cuota lines. */
  moraCents: number;
  /** Daily interest rows plus signed "Ajuste de saldo" true-ups. */
  interesesCents: number;
  /** cuota − every other section (the waterfall residual, exact by construction). */
  capitalCents: number;
}

export interface LoanPeriodView {
  /** Day after the previous anchor (the loan creation day for the first period). */
  startDate: string;
  /** The closing anchor: the cuota_day this period settled on. */
  endDate: string;
  /** Stored fixed cuota (authoritative; French-derived values are display-only). */
  cuotaCents: number;
  sections: LoanPeriodSections;
  /** 'payment' rows inside the window (a due-date payment equals the cuota). */
  paymentsCents: number;
  /** Running saldo (principal + interest + charges − payments) at each edge. */
  saldoBeforeCents: number;
  saldoAfterCents: number;
}

/**
 * Statement breakdown for a bank loan (D5): ONE indexed ledger read, grouped
 * in JS by anchor-to-anchor windows. A period is (previousAnchor, anchor] —
 * the anchor day's rows belong to the closing period — and the first period
 * opens at the loan's creation day. The trailing open period (after the last
 * anchor, cuota not yet settled) is NOT a closed cuota and is excluded.
 *
 * Callers run `listLoans` first (the lazy catch-up trigger); this read only
 * groups what is already materialized.
 */
export async function listLoanPeriods(db: Database, loanId: string): Promise<LoanPeriodView[]> {
  const [loan] = await db
    .select({
      amortizationMode: loans.amortizationMode,
      principalCents: loans.principalCents,
      fixedCuotaCents: loans.fixedCuotaCents,
      cuotaDay: loans.cuotaDay,
      createdAt: loans.createdAt,
    })
    .from(loans)
    .where(eq(loans.id, loanId))
    .limit(1);
  if (!loan || loan.amortizationMode !== "bank" || loan.cuotaDay === null) return [];

  const rows = await db
    .select({
      kind: loanPayments.kind,
      amountCents: loanPayments.amountCents,
      date: loanPayments.date,
      note: loanPayments.note,
    })
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(asc(loanPayments.date), asc(loanPayments.createdAt));
  if (rows.length === 0) return [];

  const cuotaCents = loan.fixedCuotaCents ?? 0;
  const createdIso = todayIso(loan.createdAt);

  /** Closing anchor (next day-of-month == cuotaDay, today included) for a row date. */
  const closingAnchor = (iso: string): string => {
    const [year, month, day] = iso.split("-").map(Number);
    const monthShift = day <= loan.cuotaDay! ? month - 1 : month; // this month's anchor…
    const anchorMonth = (monthShift % 12) + 1; // …or next month's
    const anchorYear = year + Math.floor(monthShift / 12);
    return `${anchorYear}-${String(anchorMonth).padStart(2, "0")}-${String(loan.cuotaDay!).padStart(2, "0")}`;
  };

  const periods: LoanPeriodView[] = [];
  let current: LoanPeriodView | null = null;
  let saldo = loan.principalCents;
  let prevEndDay = Number.NaN;

  for (const row of rows) {
    const endDate = closingAnchor(row.date);
    if (current === null || endDate !== current.endDate) {
      if (current !== null) periods.push(current);
      const startDay = Number.isNaN(prevEndDay) ? dayIndexOfIso(createdIso) : prevEndDay + 1;
      current = {
        startDate: isoOfDayIndex(startDay),
        endDate,
        cuotaCents,
        sections: {
          segurosCents: 0,
          otrosCargosCents: 0,
          moraCents: 0,
          interesesCents: 0,
          capitalCents: 0,
        },
        paymentsCents: 0,
        saldoBeforeCents: saldo,
        saldoAfterCents: 0,
      };
      prevEndDay = dayIndexOfIso(endDate);
    }
    // Classify: mora by note, seguros by note, everything else note-keyed
    // into otros; interest is signed (true-ups can be negative).
    if (row.kind === "payment") {
      current.paymentsCents += row.amountCents;
      saldo -= row.amountCents;
    } else if (row.kind === "interest") {
      current.sections.interesesCents += row.amountCents;
      saldo += row.amountCents;
    } else if (row.note === MORA_NOTE) {
      current.sections.moraCents += row.amountCents;
      saldo += row.amountCents;
    } else if (row.note === LIFE_INSURANCE_NOTE || row.note === FIRE_INSURANCE_NOTE) {
      current.sections.segurosCents += row.amountCents;
      saldo += row.amountCents;
    } else {
      current.sections.otrosCargosCents += row.amountCents;
      saldo += row.amountCents;
    }
  }
  // The last group only counts as a closed cuota when the ledger reached it.
  if (current !== null && current.endDate <= rows.at(-1)!.date) {
    periods.push(current);
  }

  for (const period of periods) {
    period.saldoAfterCents =
      period.saldoBeforeCents +
      period.sections.interesesCents +
      period.sections.segurosCents +
      period.sections.otrosCargosCents +
      period.sections.moraCents -
      period.paymentsCents;
    period.sections.capitalCents = allocateWaterfall(
      period.cuotaCents,
      period.sections.segurosCents,
      period.sections.otrosCargosCents,
      period.sections.moraCents,
      period.sections.interesesCents,
    ).capitalCents;
  }
  // Newest cuota first — the same order the history list uses.
  return periods.reverse();
}

// ---------------------------------------------------------------------------
// Revolving card cycles (statement grouping)
// ---------------------------------------------------------------------------

/** One billing cycle of a revolving card: (previous anchor, anchor]. */
export interface CardCycleView {
  /** Day after the previous cycle's closing day (loan creation for the first). */
  startDate: string;
  /** The closing anchor: the statement_day this cycle settled on. */
  endDate: string;
  /** Card purchases inside the window (linked transactions, not pending). */
  purchasesCents: number;
  /** Manual interest rows inside the window. */
  interestCents: number;
  /** Cuota de manejo (and any other charge) rows inside the window. */
  feesCents: number;
  /** Payments inside the window. */
  paymentsCents: number;
  /** false for the trailing open cycle (statement not yet closed). */
  closed: boolean;
}

/**
 * Statement breakdown for a revolving card, grouped cycle by cycle using
 * statement_day — the same anchor math as listLoanPeriods. Unlike the bank
 * statement, the trailing OPEN cycle is INCLUDED (it is the one the user is
 * currently filling before paying). Returns [] when the card is missing,
 * not revolving, or has no statement_day configured.
 */
export async function listCardCycles(
  db: Database,
  cardId: string,
  now: Date = new Date(),
): Promise<CardCycleView[]> {
  const [card] = await db
    .select({
      amortizationMode: loans.amortizationMode,
      statementDay: loans.statementDay,
      createdAt: loans.createdAt,
    })
    .from(loans)
    .where(eq(loans.id, cardId))
    .limit(1);
  if (!card || card.amortizationMode !== "revolving" || card.statementDay === null) return [];

  const [ledgerRows, purchaseRows] = await Promise.all([
    db
      .select({
        kind: loanPayments.kind,
        amountCents: loanPayments.amountCents,
        date: loanPayments.date,
      })
      .from(loanPayments)
      .where(eq(loanPayments.loanId, cardId))
      .orderBy(asc(loanPayments.date)),
    db
      .select({
        amountCents: transactions.amountCents,
        date: transactions.date,
      })
      .from(transactions)
      .where(and(eq(transactions.cardLoanId, cardId), eq(transactions.needsDetails, false)))
      .orderBy(asc(transactions.date)),
  ]);

  type Event = {
    date: string;
    amountCents: number;
    kind: "purchase" | "payment" | "interest" | "charge";
  };
  const events: Event[] = [
    ...purchaseRows.map((row) => ({ ...row, kind: "purchase" as const })),
    ...ledgerRows,
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (events.length === 0) return [];

  /** Closing anchor (next day-of-month == statementDay, today included). */
  const closingAnchor = (iso: string): string => {
    const [year, month, day] = iso.split("-").map(Number);
    const monthShift = day <= card.statementDay! ? month - 1 : month; // this month's anchor…
    const anchorMonth = (monthShift % 12) + 1; // …or next month's
    const anchorYear = year + Math.floor(monthShift / 12);
    return `${anchorYear}-${String(anchorMonth).padStart(2, "0")}-${String(card.statementDay!).padStart(2, "0")}`;
  };

  const today = todayIso(now);
  const cycles: CardCycleView[] = [];
  let current: CardCycleView | null = null;
  let prevEndDay = Number.NaN;

  for (const event of events) {
    const endDate = closingAnchor(event.date);
    if (current === null || endDate !== current.endDate) {
      if (current !== null) cycles.push(current);
      const startDay = Number.isNaN(prevEndDay)
        ? dayIndexOfIso(todayIso(card.createdAt))
        : prevEndDay + 1;
      current = {
        startDate: isoOfDayIndex(startDay),
        endDate,
        purchasesCents: 0,
        interestCents: 0,
        feesCents: 0,
        paymentsCents: 0,
        closed: endDate <= today,
      };
      prevEndDay = dayIndexOfIso(endDate);
    }
    if (event.kind === "purchase") current.purchasesCents += event.amountCents;
    else if (event.kind === "payment") current.paymentsCents += event.amountCents;
    else if (event.kind === "interest") current.interestCents += event.amountCents;
    else current.feesCents += event.amountCents;
  }
  if (current !== null) cycles.push(current);

  // Newest cycle first — the same order the history list uses.
  return cycles.reverse();
}
