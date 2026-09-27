/**
 * Finance context builder for the AI assistant (Phase 7).
 *
 * The LLM NEVER sees raw transactions and NEVER does arithmetic: this module
 * pre-computes every figure by REUSING the existing services (budgets.getMonth,
 * transactions totals via budgets context, analytics.expensesByCategory /
 * monthlyTotals, savings.listGoals) — no duplicated SQL. The model only
 * narrates over the given numbers.
 *
 * Canonical values are integer cents (R2). `toPromptContext` renders the same
 * data as a compact plain object with es-AR formatted amounts so the prompt
 * never asks the model to format or convert anything itself.
 *
 * Kept free of Next.js imports and pure-ish over the DB, like every service,
 * so it tests against PGlite and runs under plain node (eval script).
 */
import { formatCents, formatPerMillon, percentage } from "@/lib/money";
import type { Database } from "@/db";
import { transactionTotals } from "@/features/transactions/service";
import { todayIso } from "@/lib/date";
import { getMonth, previousMonth } from "@/features/budgets/service";
import { monthBounds, type ProgressStatus } from "@/features/budgets/progress";
import {
  DEFAULT_MONTHS_BACK,
  expensesByCategory,
  monthlyTotals,
} from "@/features/analytics/service";
import { listGoals, getPatrimony } from "@/features/savings/service";
import { formatRatePercent, investmentValueCents } from "@/features/savings/math";
import { listLoans } from "@/features/loans/service";

/** Top spender categories detailed in the context; the rest roll into "otros". */
export const TOP_CATEGORIES_LIMIT = 5;
/** Max month-over-month changes reported (most relevant first). */
export const CATEGORY_CHANGES_LIMIT = 5;
/**
 * A category counts as relevant for a MoM delta only when it represents at
 * least this share of its month's total expenses (in EITHER month). Guards
 * against misleading huge ratios on cents-sized bases.
 */
export const DELTA_MIN_SHARE = 0.02;
/** Trend window length (months), mirroring the dashboard chart. */
export const TREND_MONTHS = DEFAULT_MONTHS_BACK;

export interface ContextCategoryBudget {
  plannedCents: number;
  pct: number;
  status: ProgressStatus;
}

export interface ContextCategory {
  name: string;
  cents: number;
  /** Share of the month's total expenses, 2 decimals. */
  pct: number;
  /** Present only when the category has a budget with planned > 0. */
  budget: ContextCategoryBudget | null;
}

export interface ContextCategoryChange {
  name: string;
  currentCents: number;
  previousCents: number;
  /** (current - previous) / previous, 2 decimals; null when previous is 0 (new spend). */
  deltaPct: number | null;
}

export interface ContextBolsa {
  name: string;
  /** Where the money is held; null = unset. */
  institution: string | null;
  /** 'ahorro' (savings bag) vs 'inversión' (acciones). */
  kind: "savings" | "investment";
  /**
   * Savings: net accumulated (deposits − withdrawals + interest).
   * Investments: the manually updated current value (net fallback) — same
   * rule as the UI and getPatrimony, so a valuation-only investment never
   * narrates as $0.
   */
  netCents: number;
  /** Annual rate in bp; null = no yield. */
  annualRateBp: number | null;
  /** Daily accrual mode; null when there is no rate. */
  accrualMode: "simple" | "compound" | null;
}

/** A fixed (non-revolving) debt: mortgage, investment line, simple tracker. */
export interface ContextDeuda {
  name: string;
  entity: string;
  kind: "credit_card" | "investment_line" | "mortgage" | "other";
  /** Original borrowed amount. */
  principalCents: number;
  /** Computed outstanding (principal + interest + charges − payments). */
  outstandingCents: number;
  /** Sum of 'payment' rows so far. */
  paidCents: number;
  /** Interest generated so far (engine + manual true-ups). */
  interestCents: number;
  /** Bank cuota components charged so far (seguros, otros cargos, mora). */
  chargesCents: number;
  /** Simple-tracker TNA in bp; null on bank loans. */
  annualRateBp: number | null;
  /** Bank calibration block; null on simple trackers. */
  bank: {
    /** EA efectivamente cobrada in bp — the accrual driver. */
    chargedRateBp: number;
    /** Pactada in bp — display only; null when unset. */
    contractualRateBp: number | null;
    termMonths: number;
    fixedCuotaCents: number;
    cuotaDay: number;
    /** Mora annual rate in bp; null = none. */
    moraRateBp: number | null;
    /** Per-millón insurance rates (×100.000 basis); null = component off. */
    lifeInsuranceRatePerMillonX100k: number | null;
    fireInsuranceRatePerMillonX100k: number | null;
    /** Fixed "Otros cargos" per period; null = none. */
    otherChargesCents: number | null;
  } | null;
  isActive: boolean;
}

/** A revolving credit card: cupo usage plus the card's finance facts. */
export interface ContextTarjeta {
  name: string;
  entity: string;
  /** Total credit limit (cupo). */
  creditLimitCents: number;
  /** Credit already consumed = limit − available. */
  usedCents: number;
  /** Cupo disponible, clamped to [0, limit]. */
  availableCents: number;
  /** Pending balance; negative = saldo a favor. */
  outstandingCents: number;
  /** Card purchases accumulated so far (they live in transactions). */
  purchasesCents: number;
  /** Card payments accumulated so far. */
  paidCents: number;
  /** Manual interest entered at payment time, accumulated. */
  interestCents: number;
  /** Fixed cuota de manejo; null = sin cuota. */
  managementFeeCents: number | null;
  /** Billing-cycle close day; null = unconfigured. */
  statementDay: number | null;
  isActive: boolean;
}

export interface FinanceContext {
  /** 'YYYY-MM'. */
  month: string;
  /** e.g. "septiembre 2026" (prompt-facing, neutral Spanish). */
  monthLabel: string;
  /** 'YYYY-MM-DD' the context was generated for. */
  today: string;
  isCurrentMonth: boolean;
  daysInMonth: number;
  /** Day of month reached so far (full length for past months, 0 for future). */
  daysElapsed: number;
  summary: {
    incomeCents: number;
    expenseCents: number;
    balanceCents: number;
    /** null when the month has no budget with planned > 0. */
    budget: { plannedCents: number; spentCents: number; pct: number } | null;
  };
  topExpenseCategories: ContextCategory[];
  /** Rollup of everything outside the top N; null when there is nothing left. */
  otherCategories: { name: string; cents: number; pct: number } | null;
  categoryChanges: ContextCategoryChange[];
  /** Month expenses split by payment method (the movement's medio de pago). */
  paymentSplit: { cashCents: number; cardCents: number };
  /** Savings bags (goals + investments) summary — net balances and rates. */
  bolsas: ContextBolsa[];
  /** Fixed debts; revolving cards live in `tarjetas` instead. */
  deudas: ContextDeuda[];
  /** Revolving credit cards — cupo, saldo and card finance facts. */
  tarjetas: ContextTarjeta[];
  /** Total household debt (every loan + card, outstanding clamped at 0). */
  totalDebtCents: number;
  /** Net worth: savings + investments + mortgaged properties − debt. */
  patrimonio: {
    ahorroCents: number;
    inversionesCents: number;
    /** Mortgaged properties at their stated value (the mortgage's asset). */
    inmueblesCents: number;
    netoCents: number;
  };
  trend: {
    months: number;
    avgExpenseCents: number;
    /** (current - avg) / avg, 2 decimals; 0 when the average is 0. */
    currentVsAvgPct: number;
  };
  /** Raw data-completeness facts (never projections). */
  notes: string[];
}

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${MONTH_NAMES[monthNumber - 1]} ${year}`;
}

/**
 * Builds the grounded finance context for `month` by reusing the existing
 * feature services (one aggregate query each — no duplicated SQL).
 * `today` is injectable for deterministic tests.
 */
export async function buildFinanceContext(
  db: Database,
  month: string,
  today: string = todayIso(),
): Promise<FinanceContext> {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error(`buildFinanceContext: invalid month "${month}"`);

  const [budgetView, currentSlices, previousSlices, trendTotals, goals, loans, cashTotals, cardTotals] =
    await Promise.all([
      getMonth(db, month),
      expensesByCategory(db, { month }),
      expensesByCategory(db, { month: previousMonth(month) }),
      monthlyTotals(db, month, TREND_MONTHS),
      listGoals(db),
      // Single source of debt/cupo math (also runs the lazy interest
      // catch-up, so the figures the model narrates are current).
      listLoans(db),
      // Medio de pago split: the month's expenses by how they were paid.
      transactionTotals(db, { month, paymentMethod: "cash" }),
      transactionTotals(db, { month, paymentMethod: "card" }),
    ]);
  if (!budgetView) throw new Error(`buildFinanceContext: invalid month "${month}"`);

  // Household totals ride along with getMonth (it already reuses
  // transactions.transactionTotals internally — never queried twice).
  const totals = await transactionTotals(db, { month });
  const expenseCents = totals.expenseCents;

  const budgetByCategory = new Map(
    budgetView.rows
      .filter((row) => row.plannedCents > 0)
      .map((row) => [
        row.categoryName,
        { plannedCents: row.plannedCents, pct: row.pct, status: row.status },
      ]),
  );

  const topExpenseCategories: ContextCategory[] = currentSlices.map((slice) => ({
    name: slice.name,
    cents: slice.cents,
    pct: slice.pct,
    budget: budgetByCategory.get(slice.name) ?? null,
  }));
  const top = topExpenseCategories.slice(0, TOP_CATEGORIES_LIMIT);
  const restCents = topExpenseCategories
    .slice(TOP_CATEGORIES_LIMIT)
    .reduce((total, slice) => total + slice.cents, 0);

  const categoryChanges = buildCategoryChanges(
    topExpenseCategories.map((slice) => ({ name: slice.name, cents: slice.cents })),
    previousSlices.map((slice) => ({ name: slice.name, cents: slice.cents })),
    expenseCents,
    previousSlices.reduce((total, slice) => total + slice.cents, 0),
  );

  const currentMonth = today.slice(0, 7);
  const isCurrentMonth = month === currentMonth;
  const daysInMonth = Number(bounds.end.slice(8, 10));
  const daysElapsed = isCurrentMonth
    ? Number(today.slice(8, 10))
    : month < currentMonth
      ? daysInMonth
      : 0;

  const notes: string[] = [];
  if (isCurrentMonth) {
    notes.push(
      `El mes está en curso: día ${daysElapsed} de ${daysInMonth}; los totales son parciales.`,
    );
  } else if (month < currentMonth) {
    notes.push(`El mes está completo (${daysInMonth} días).`);
  } else {
    notes.push("El mes analizado aún no comienza; no hay datos.");
  }
  if (totals.incomeCents === 0 && expenseCents === 0) {
    notes.push("No hay movimientos registrados en este mes.");
  }

  const trendExpenseTotal = trendTotals.reduce((total, row) => total + row.expenseCents, 0);
  const avgExpenseCents = Math.round(trendExpenseTotal / trendTotals.length);

  // Debts split by engine: revolving cards get their own section (cupo),
  // every other loan lands in `deudas`.
  const tarjetas = loans
    .filter((loan) => loan.amortizationMode === "revolving")
    .map((card) => ({
      name: card.name,
      entity: card.entity,
      creditLimitCents: card.creditLimitCents ?? 0,
      usedCents: card.creditLimitCents !== null
        ? card.creditLimitCents - (card.availableCents ?? 0)
        : 0,
      availableCents: card.availableCents ?? 0,
      outstandingCents: card.outstandingCents,
      purchasesCents: card.purchasesCents ?? 0,
      paidCents: card.paidCents,
      interestCents: card.interestCents,
      managementFeeCents: card.managementFeeCents,
      statementDay: card.statementDay,
      isActive: card.isActive,
    }));
  const deudas = loans
    .filter((loan) => loan.amortizationMode !== "revolving")
    .map((loan) => ({
      name: loan.name,
      entity: loan.entity,
      kind: loan.kind,
      principalCents: loan.principalCents,
      outstandingCents: loan.outstandingCents,
      paidCents: loan.paidCents,
      interestCents: loan.interestCents,
      chargesCents: loan.chargesCents,
      annualRateBp: loan.annualRateBp,
      bank:
        loan.amortizationMode === "bank"
          ? {
              chargedRateBp: loan.chargedRateBp ?? 0,
              contractualRateBp: loan.contractualRateBp,
              termMonths: loan.termMonths ?? 0,
              fixedCuotaCents: loan.fixedCuotaCents ?? 0,
              cuotaDay: loan.cuotaDay ?? 0,
              moraRateBp: loan.moraRateBp,
              lifeInsuranceRatePerMillonX100k: loan.lifeInsuranceRatePerMillonX100k,
              fireInsuranceRatePerMillonX100k: loan.fireInsuranceRatePerMillonX100k,
              otherChargesCents: loan.otherChargesCents,
            }
          : null,
      isActive: loan.isActive,
    }));
  // Same clamp as getDebtCents, computed over the rows we already hold (a
  // saldo a favor on a card never subtracts from the household debt).
  const totalDebtCents = loans.reduce(
    (total, loan) => total + Math.max(loan.outstandingCents, 0),
    0,
  );
  // Net worth reuses getPatrimony over the rows already fetched (no extra
  // queries): ahorro + inversiones + inmuebles − deuda.
  const patrimony = await getPatrimony(db, goals, loans);

  return {
    month,
    monthLabel: monthLabel(month),
    today,
    isCurrentMonth,
    daysInMonth,
    daysElapsed,
    summary: {
      incomeCents: totals.incomeCents,
      expenseCents,
      balanceCents: totals.balanceCents,
      budget:
        budgetView.totals.plannedCents > 0
          ? {
              plannedCents: budgetView.totals.plannedCents,
              spentCents: budgetView.totals.spentCents,
              pct: budgetView.totals.pct,
            }
          : null,
    },
    topExpenseCategories: top,
    otherCategories:
      restCents > 0
        ? { name: "Otros", cents: restCents, pct: percentage(restCents, expenseCents) }
        : null,
    categoryChanges,
    paymentSplit: {
      cashCents: cashTotals.expenseCents,
      cardCents: cardTotals.expenseCents,
    },
    bolsas: goals.map((goal) => ({
      name: goal.name,
      institution: goal.institution,
      kind: goal.kind,
      // Investments narrate their valuation (currentValue ?? net), not the
      // contributions ledger — the same value the UI shows.
      netCents:
        goal.kind === "investment"
          ? investmentValueCents(goal.netCents, goal.currentValueCents)
          : goal.netCents,
      annualRateBp: goal.annualRateBp,
      accrualMode: goal.accrualMode,
    })),
    deudas,
    tarjetas,
    totalDebtCents,
    patrimonio: {
      ahorroCents: patrimony.savingsCents,
      inversionesCents: patrimony.investmentsCents,
      inmueblesCents: patrimony.propertiesCents,
      netoCents: patrimony.totalCents,
    },
    trend: {
      months: trendTotals.length,
      avgExpenseCents,
      currentVsAvgPct: percentage(expenseCents - avgExpenseCents, avgExpenseCents),
    },
    notes,
  };
}

/**
 * Month-over-month notable changes. A category participates only when it
 * reaches DELTA_MIN_SHARE of its month's total in EITHER month, the current
 * month has expenses at all, and the delta is not exactly 0. New spend
 * (previous 0) reports deltaPct null instead of an infinite ratio.
 */
function buildCategoryChanges(
  current: { name: string; cents: number }[],
  previous: { name: string; cents: number }[],
  currentTotalCents: number,
  previousTotalCents: number,
): ContextCategoryChange[] {
  if (currentTotalCents <= 0) return [];
  const prevByName = new Map(previous.map((slice) => [slice.name, slice.cents]));
  const names = new Set([...current.map((slice) => slice.name), ...prevByName.keys()]);

  const changes: (ContextCategoryChange & { relevanceCents: number })[] = [];
  for (const name of names) {
    const currentCents = current.find((slice) => slice.name === name)?.cents ?? 0;
    const previousCents = prevByName.get(name) ?? 0;
    const relevant =
      (currentTotalCents > 0 && currentCents / currentTotalCents >= DELTA_MIN_SHARE) ||
      (previousTotalCents > 0 && previousCents / previousTotalCents >= DELTA_MIN_SHARE);
    if (!relevant) continue;
    const deltaPct =
      previousCents > 0 ? percentage(currentCents - previousCents, previousCents) : null;
    if (deltaPct === 0) continue; // unchanged is not notable
    changes.push({
      name,
      currentCents,
      previousCents,
      deltaPct,
      relevanceCents: Math.max(currentCents, previousCents),
    });
  }
  return changes
    .sort((a, b) => b.relevanceCents - a.relevanceCents)
    .slice(0, CATEGORY_CHANGES_LIMIT)
    .map((change) => ({
      name: change.name,
      currentCents: change.currentCents,
      previousCents: change.previousCents,
      deltaPct: change.deltaPct,
    }));
}

const STATUS_LABELS: Record<ProgressStatus, string> = {
  ok: "bien",
  warn: "en riesgo",
  over: "excedido",
};

/** Prompt-facing debt kind labels (neutral Spanish). */
const DEBT_KIND_LABELS: Record<ContextDeuda["kind"], string> = {
  credit_card: "tarjeta (rastreador simple)",
  investment_line: "libre inversión",
  mortgage: "hipoteca",
  other: "otro",
};

/** es-AR amount for prompt text; NBSP after the sign swapped for a plain space. */
function ar(cents: number): string {
  return formatCents(cents).replace(/\u00A0/g, " ");
}

/** Signed percentage with Spanish decimal comma for the prompt text. */
function signedPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${String(pct).replace(".", ",")}%`;
}

/**
 * Prompt-facing rendering of the context: same data, but every monetary
 * figure arrives pre-formatted in es-AR so the model NEVER converts cents or
 * does arithmetic — it only quotes what it reads. Spanish keys: this object
 * is content for the prompt, like seed data.
 */
export function toPromptContext(ctx: FinanceContext): Record<string, unknown> {
  const { summary } = ctx;
  return {
    mes: `${ctx.monthLabel} (${ctx.month})`,
    hoy: ctx.today,
    notas: ctx.notes,
    resumen: {
      ingresos: ar(summary.incomeCents),
      gastos: ar(summary.expenseCents),
      saldo: ar(summary.balanceCents),
      presupuesto: summary.budget
        ? {
            planificado: ar(summary.budget.plannedCents),
            gastado: ar(summary.budget.spentCents),
            porcentaje: `${String(summary.budget.pct).replace(".", ",")}%`,
          }
        : "sin presupuesto para este mes",
    },
    mayores_gastos_por_categoria: ctx.topExpenseCategories.map((category) => ({
      categoria: category.name,
      gasto: ar(category.cents),
      porcentaje_del_total: `${String(category.pct).replace(".", ",")}%`,
      presupuesto: category.budget
        ? {
            planificado: ar(category.budget.plannedCents),
            porcentaje_usado: `${String(category.budget.pct).replace(".", ",")}%`,
            estado: STATUS_LABELS[category.budget.status],
          }
        : "sin presupuesto",
    })),
    otras_categorias: ctx.otherCategories
      ? { categoria: ctx.otherCategories.name, gasto: ar(ctx.otherCategories.cents) }
      : undefined,
    cambios_vs_mes_anterior: ctx.categoryChanges.map((change) => ({
      categoria: change.name,
      este_mes: ar(change.currentCents),
      mes_anterior: ar(change.previousCents),
      variacion:
        change.deltaPct === null
          ? "gasto nuevo (sin gasto el mes anterior)"
          : signedPct(change.deltaPct),
    })),
    bolsas: ctx.bolsas.map((bolsa) => ({
      nombre: bolsa.name,
      institucion: bolsa.institution ?? undefined,
      tipo: bolsa.kind === "savings" ? "ahorro" : "inversión",
      saldo_neto: ar(bolsa.netCents),
      tasa:
        bolsa.annualRateBp === null
          ? undefined
          : `${formatRatePercent(bolsa.annualRateBp)}% ${
              bolsa.accrualMode === "compound" ? "TEA (compuesto)" : "TNA (simple)"
            }`,
    })),
    medios_de_pago: {
      gastos_en_efectivo: ar(ctx.paymentSplit.cashCents),
      gastos_con_tarjeta: ar(ctx.paymentSplit.cardCents),
    },
    deudas: ctx.deudas.map((deuda) => ({
      nombre: deuda.name,
      entidad: deuda.entity,
      tipo: DEBT_KIND_LABELS[deuda.kind],
      estado: deuda.isActive ? "activa" : "inactiva",
      capital: ar(deuda.principalCents),
      saldo_pendiente: ar(deuda.outstandingCents),
      pagado: ar(deuda.paidCents),
      intereses_generados: ar(deuda.interestCents),
      cargos: ar(deuda.chargesCents),
      // Rates pre-formatted: the model quotes, never converts.
      tasa: deuda.bank
        ? {
            ea_cobrada: `${formatRatePercent(deuda.bank.chargedRateBp)}%`,
            pactada:
              deuda.bank.contractualRateBp !== null
                ? `${formatRatePercent(deuda.bank.contractualRateBp)}%`
                : undefined,
            mora:
              deuda.bank.moraRateBp !== null
                ? `${formatRatePercent(deuda.bank.moraRateBp)}%`
                : undefined,
          }
        : deuda.annualRateBp !== null
          ? { tna: `${formatRatePercent(deuda.annualRateBp)}%` }
          : undefined,
      cuota: deuda.bank
        ? {
            monto: ar(deuda.bank.fixedCuotaCents),
            dia_del_mes: deuda.bank.cuotaDay,
            plazo_meses: deuda.bank.termMonths,
            otros_cargos:
              deuda.bank.otherChargesCents !== null
                ? ar(deuda.bank.otherChargesCents)
                : undefined,
            seguro_vida_por_millon:
              deuda.bank.lifeInsuranceRatePerMillonX100k !== null
                ? formatPerMillon(deuda.bank.lifeInsuranceRatePerMillonX100k)
                : undefined,
            seguro_incendio_por_millon:
              deuda.bank.fireInsuranceRatePerMillonX100k !== null
                ? formatPerMillon(deuda.bank.fireInsuranceRatePerMillonX100k)
                : undefined,
          }
        : undefined,
    })),
    tarjetas: ctx.tarjetas.map((tarjeta) => ({
      nombre: tarjeta.name,
      entidad: tarjeta.entity,
      cupo_total: ar(tarjeta.creditLimitCents),
      cupo_usado: ar(tarjeta.usedCents),
      cupo_disponible: ar(tarjeta.availableCents),
      // Negative outstanding = the bank owes the household (saldo a favor).
      saldo_pendiente: ar(Math.max(tarjeta.outstandingCents, 0)),
      saldo_a_favor:
        tarjeta.outstandingCents < 0 ? ar(-tarjeta.outstandingCents) : undefined,
      compras_con_tarjeta: ar(tarjeta.purchasesCents),
      pagos_acumulados: ar(tarjeta.paidCents),
      intereses_generados: ar(tarjeta.interestCents),
      cuota_de_manejo: tarjeta.managementFeeCents !== null ? ar(tarjeta.managementFeeCents) : undefined,
      dia_de_corte: tarjeta.statementDay ?? undefined,
      estado: tarjeta.isActive ? "activa" : "inactiva",
    })),
    deuda_total: ar(ctx.totalDebtCents),
    patrimonio: {
      ahorro: ar(ctx.patrimonio.ahorroCents),
      inversiones: ar(ctx.patrimonio.inversionesCents),
      inmuebles: ar(ctx.patrimonio.inmueblesCents),
      patrimonio_neto: ar(ctx.patrimonio.netoCents),
    },
    tendencia: {
      meses_analizados: ctx.trend.months,
      gasto_promedio_mensual: ar(ctx.trend.avgExpenseCents),
      este_mes_vs_promedio: signedPct(ctx.trend.currentVsAvgPct),
    },
  };
}
