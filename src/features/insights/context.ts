/**
 * Finance context builder for the AI assistant (Phase 7).
 *
 * The LLM NEVER sees raw transactions and NEVER does arithmetic: this module
 * pre-computes every figure by REUSING the existing services (budgets.getMonth,
 * transactions totals via budgets context, analytics.expensesByCategory /
 * monthlyTotals, envelopes.monthlyProgress) — no duplicated SQL. The model only
 * narrates over the given numbers.
 *
 * Canonical values are integer cents (R2). `toPromptContext` renders the same
 * data as a compact plain object with es-AR formatted amounts so the prompt
 * never asks the model to format or convert anything itself.
 *
 * Kept free of Next.js imports and pure-ish over the DB, like every service,
 * so it tests against PGlite and runs under plain node (eval script).
 */
import { formatCents, percentage } from "@/lib/money";
import type { Database } from "@/db";
import { todayIso, transactionTotals } from "@/features/transactions/service";
import { getMonth, previousMonth } from "@/features/budgets/service";
import { monthBounds, type ProgressStatus } from "@/features/budgets/progress";
import {
  DEFAULT_MONTHS_BACK,
  expensesByCategory,
  monthlyTotals,
} from "@/features/analytics/service";
import { monthlyProgress } from "@/features/envelopes/service";

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

export interface ContextEnvelope {
  name: string;
  scope: "individual" | "common";
  memberName: string | null;
  spentCents: number;
  plannedCents: number;
  pct: number;
  status: ProgressStatus;
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
  envelopes: ContextEnvelope[];
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

  const [budgetView, currentSlices, previousSlices, trendTotals, envelopeRows] =
    await Promise.all([
      getMonth(db, month),
      expensesByCategory(db, { month }),
      expensesByCategory(db, { month: previousMonth(month) }),
      monthlyTotals(db, month, TREND_MONTHS),
      monthlyProgress(db, month),
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
    envelopes: envelopeRows.map((row) => ({
      name: row.name,
      scope: row.scope,
      memberName: row.memberName,
      spentCents: row.spentCents,
      plannedCents: row.plannedCents,
      pct: row.pct,
      status: row.status,
    })),
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
    bolsas: ctx.envelopes.map((envelope) => ({
      nombre: envelope.name,
      ambito: envelope.scope === "common" ? "común" : "individual",
      integrante: envelope.memberName ?? undefined,
      gastado: ar(envelope.spentCents),
      planificado: ar(envelope.plannedCents),
      porcentaje: `${String(envelope.pct).replace(".", ",")}%`,
      estado: STATUS_LABELS[envelope.status],
    })),
    tendencia: {
      meses_analizados: ctx.trend.months,
      gasto_promedio_mensual: ar(ctx.trend.avgExpenseCents),
      este_mes_vs_promedio: signedPct(ctx.trend.currentVsAvgPct),
    },
  };
}
