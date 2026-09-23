/**
 * Pure savings math — no DB, no Next.js imports (client components import
 * this directly, same contract as budgets/progress.ts).
 *
 * Money is ALWAYS integer cents (R2). Contributions accumulate across ALL
 * months — a savings pool is cumulative, unlike budget monthly progress.
 */
import { percentage } from "@/lib/money";
import { todayIso } from "@/lib/date";
import { computeProgress, type Progress } from "@/features/budgets/progress";

/** Net accumulation: deposits minus withdrawals (exact cents). */
export function computeNetCents(depositsCents: number, withdrawalsCents: number): number {
  return depositsCents - withdrawalsCents;
}

/**
 * Progress toward the target using the SHARED budgets math (one source of
 * truth for thresholds and divide-by-zero). No target → no bar (null).
 */
export function computeGoalProgress(
  netCents: number,
  targetCents: number | null,
): Progress | null {
  if (targetCents === null) return null;
  return computeProgress(targetCents, netCents);
}

/**
 * Investment return: (current − net invested) / net invested, as a
 * 2-decimal percentage. Never-updated value falls back to net invested
 * (→ 0%) and a zero net invested avoids division by zero (→ 0%).
 */
export function computeInvestmentReturn(
  netInvestedCents: number,
  currentValueCents: number | null,
): number {
  if (netInvestedCents <= 0) return 0;
  const value = currentValueCents ?? netInvestedCents;
  return percentage(value - netInvestedCents, netInvestedCents);
}

/** Effective patrimony value: the current valuation, else net invested. */
export function investmentValueCents(
  netCents: number,
  currentValueCents: number | null,
): number {
  return currentValueCents ?? netCents;
}

/**
 * Basis points → es-AR percent copy ("3550 → 35,5", "7000 → 70"). Shared by
 * the TNA chip in the UI and the accrual engine's interest note.
 */
export function formatRatePercent(rateBp: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(rateBp / 100);
}

/**
 * Whole months from today until the deadline month; negative when overdue,
 * null when there is no deadline. Month granularity on purpose ("vence en
 * N meses" — day precision would make the copy jitter daily).
 */
export function monthsUntilDeadline(
  deadline: string | null,
  today: string = todayIso(),
): number | null {
  if (!deadline) return null;
  const [todayYear, todayMonth] = today.split("-").map(Number);
  const [goalYear, goalMonth] = deadline.split("-").map(Number);
  return (goalYear - todayYear) * 12 + (goalMonth - todayMonth);
}
