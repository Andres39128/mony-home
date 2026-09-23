/**
 * Shared progress math for budgets and savings goals — the single source of
 * truth for "how much of the plan is reached". Pure functions only (no DB,
 * no Next.js) so client components can import the status constants without
 * pulling server code into the bundle.
 *
 * Money is ALWAYS integer cents (R2); the ratio is computed on cents, the
 * displayed pct is a 2-decimal percentage. Divide-by-zero (planned 0) → 0%.
 */
import { percentage } from "@/lib/money";

/** Spent/planned ratio at which the progress bar turns amber. */
export const PROGRESS_WARN_RATIO = 0.75;
/** Spent/planned ratio at which the progress bar turns red. */
export const PROGRESS_OVER_RATIO = 1;

export type ProgressStatus = "ok" | "warn" | "over";

export interface Progress {
  /** Spent over planned, as a 2-decimal percentage (0 when planned is 0). */
  pct: number;
  /** planned - spent; negative means over budget. */
  remainingCents: number;
  status: ProgressStatus;
}

export function computeProgress(plannedCents: number, spentCents: number): Progress {
  const ratio = plannedCents > 0 ? spentCents / plannedCents : 0;
  const status: ProgressStatus =
    ratio >= PROGRESS_OVER_RATIO ? "over" : ratio >= PROGRESS_WARN_RATIO ? "warn" : "ok";
  return {
    pct: percentage(spentCents, plannedCents),
    remainingCents: plannedCents - spentCents,
    status,
  };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Inclusive [firstDay, lastDay] ISO strings of a 'YYYY-MM' month, or null
 * when malformed. Computed with fixed UTC arithmetic — never local-timezone
 * Date parsing of the string.
 */
export function monthBounds(month: string): { start: string; end: string } | null {
  if (!MONTH_RE.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  // Day 0 of the NEXT month index = last day of this one.
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}
