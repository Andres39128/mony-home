/**
 * Derived projections (F4) — savings goal ETA and loan payoff date.
 *
 * ZERO new state, ZERO migrations: every figure is computed on READ from the
 * existing ledgers, same philosophy as the budget rollover. Pure functions
 * are client-safe; the DB-fed builder follows the repo service shape and is
 * testable against PGlite.
 *
 * Honest-bounds rule: the loan payoff uses cuota vs outstanding, so interest
 * makes it a LOWER bound — the copy says "estimada". The goal ETA replays the
 * accrual engine's rate semantics MONTHLY (TNA/12 simple, TEA^(1/12)−1
 * compound — the monthly mirror of savings/accrual.ts dailyRate) plus the
 * trailing-window average net contribution, capped at 600 iterations.
 */
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { savingsContributions } from "@/db/schema";
import type { Database } from "@/db";
import { todayIso } from "@/lib/date";
import { monthLabel, shiftMonth } from "@/features/transactions/month-nav";
import type { GoalView } from "@/features/savings/service";
import type { LoanView } from "@/features/loans/service";

/** Trailing months of contribution history that define the "rhythm". */
export const PROJECTION_WINDOW_MONTHS = 6;
/** Simulation cap: beyond 50 years the honest answer is "no rhythm". */
export const MAX_PROJECTION_MONTHS = 600;

export interface GoalEtaInput {
  targetCents: number | null;
  currentCents: number;
  annualRateBp: number | null;
  accrualMode: "simple" | "compound" | null;
  /** Trailing-window average NET monthly contribution (deposits − withdrawals). */
  avgNetContributionCents: number;
}

/** Monthly rate fraction — the monthly mirror of savings/accrual.ts dailyRate. */
function monthlyRate(annualRateBp: number | null, mode: "simple" | "compound" | null): number {
  if (annualRateBp === null || annualRateBp <= 0) return 0;
  const annual = annualRateBp / 10_000;
  return mode === "compound" ? Math.pow(1 + annual, 1 / 12) - 1 : annual / 12;
}

/**
 * Months until the savings goal reaches its target, simulating month by
 * month: balance += balance*rate + avgNetContribution (cents rounded per
 * month, like the accrual engine rounds per day). Returns:
 * - null when the goal has no target,
 * - 0 when the target is already reached,
 * - null when unreachable: no rhythm (avg ≤ 0) AND no interest, or the
 *   {@link MAX_PROJECTION_MONTHS} cap expires first.
 */
export function goalEta(input: GoalEtaInput): number | null {
  if (input.targetCents === null) return null;
  if (input.currentCents >= input.targetCents) return 0;
  const rate = monthlyRate(input.annualRateBp, input.accrualMode);
  if (input.avgNetContributionCents <= 0 && rate === 0) return null;

  let balance = input.currentCents;
  for (let months = 1; months <= MAX_PROJECTION_MONTHS; months++) {
    balance = Math.round(balance + balance * rate + input.avgNetContributionCents);
    if (balance >= input.targetCents) return months;
  }
  return null;
}

/** First day ('YYYY-MM-01') of the month `PROJECTION_WINDOW_MONTHS − 1` back. */
function trailingWindowStart(today: string): string {
  return `${shiftMonth(today.slice(0, 7), -(PROJECTION_WINDOW_MONTHS - 1))}-01`;
}

/**
 * NET contributions (deposits − withdrawals) per goal inside the trailing
 * window, up to today. ONE grouped indexed query for every goal; interest
 * rows never count (the rate itself models them). Missing goal = no rows.
 */
export async function netContributionsByGoal(
  db: Database,
  today: string = todayIso(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      goalId: savingsContributions.goalId,
      net: sql<string | null>`coalesce(sum(case ${savingsContributions.kind} when 'deposit' then ${savingsContributions.amountCents} when 'withdrawal' then -${savingsContributions.amountCents} else 0 end), 0)`,
    })
    .from(savingsContributions)
    .where(
      and(
        gte(savingsContributions.date, trailingWindowStart(today)),
        lte(savingsContributions.date, today),
        inArray(savingsContributions.kind, ["deposit", "withdrawal"]),
      ),
    )
    .groupBy(savingsContributions.goalId);
  return new Map(rows.map((row) => [row.goalId, Number(row.net ?? 0)]));
}

/** The inputs {@link goalEta} needs, picked from a goal view. */
export type GoalEtaView = Pick<
  GoalView,
  "kind" | "targetCents" | "netCents" | "annualRateBp" | "accrualMode"
>;

/**
 * User-facing ETA copy for one savings goal, or null when there is nothing
 * to show (investments and target-less goals). Shares ONE string per surface
 * (panel + assistant context) so both narrate the same figure.
 */
export function goalEtaLabel(
  goal: GoalEtaView,
  avgNetContributionCents: number,
  today: string = todayIso(),
): string | null {
  if (goal.kind !== "savings" || goal.targetCents === null) return null;
  const eta = goalEta({
    targetCents: goal.targetCents,
    currentCents: goal.netCents,
    annualRateBp: goal.annualRateBp,
    accrualMode: goal.accrualMode,
    avgNetContributionCents,
  });
  if (eta === null) return "Sin ritmo de aportes todavía";
  if (eta === 0) return "Objetivo alcanzado";
  return `A este ritmo: ~${monthLabel(shiftMonth(today.slice(0, 7), eta))}`;
}

/**
 * Whole months of fixed cuota left on a BANK loan: ceil(outstanding/cuota).
 * Interest keeps accruing, so the real end date is LATER — a lower bound.
 * Revolving cards and zero/absent cuota → null (debt depends on usage).
 */
export function loanPayoffMonths(
  outstandingCents: number,
  fixedCuotaCents: number | null,
): number | null {
  if (fixedCuotaCents === null || fixedCuotaCents <= 0) return null;
  if (outstandingCents <= 0) return null;
  return Math.ceil(outstandingCents / fixedCuotaCents);
}

/** User-facing payoff copy for one loan view, or null when not projectable. */
export function loanPayoffLabel(
  loan: Pick<LoanView, "amortizationMode" | "outstandingCents" | "fixedCuotaCents">,
  today: string = todayIso(),
): string | null {
  if (loan.amortizationMode !== "bank") return null;
  const months = loanPayoffMonths(loan.outstandingCents, loan.fixedCuotaCents);
  if (months === null) return null;
  return `Última cuota estimada: ~${monthLabel(shiftMonth(today.slice(0, 7), months))}`;
}

/**
 * Builder for the /bolsas panel: goal id → ETA copy (null = show nothing).
 * `goals` accepts a precomputed listGoals() result so callers that already
 * ran the lazy catch-up don't pay for a second goals query.
 */
export async function goalEtaLabels(
  db: Database,
  goals: GoalView[],
  today: string = todayIso(),
): Promise<Record<string, string | null>> {
  const withTarget = goals.filter((goal) => goal.kind === "savings" && goal.targetCents !== null);
  if (withTarget.length === 0) return {};
  const nets = await netContributionsByGoal(db, today);
  return Object.fromEntries(
    goals.map((goal) => [
      goal.id,
      goalEtaLabel(goal, (nets.get(goal.id) ?? 0) / PROJECTION_WINDOW_MONTHS, today),
    ]),
  );
}

/** Pure builder for the /prestamos panel: loan id → payoff copy or null. */
export function loanPayoffLabels(
  loans: Pick<LoanView, "id" | "amortizationMode" | "outstandingCents" | "fixedCuotaCents">[],
  today: string = todayIso(),
): Record<string, string | null> {
  return Object.fromEntries(loans.map((loan) => [loan.id, loanPayoffLabel(loan, today)]));
}
