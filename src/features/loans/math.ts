/**
 * Pure loans math — no DB, no Next.js imports (client components import
 * this directly, same contract as savings/math.ts).
 *
 * Money is ALWAYS integer cents (R2). The outstanding balance is never
 * stored: outstanding = principal + accrued interest − payments, computed
 * from the loan_payments ledger.
 */
import { percentage } from "@/lib/money";

/** Outstanding debt: principal plus charges minus payments (exact cents). */
export function computeOutstanding(
  principalCents: number,
  interestCents: number,
  paidCents: number,
): number {
  return principalCents + interestCents - paidCents;
}

/** Share of the principal already paid back (0 when principal <= 0). */
export function computePaidPct(principalCents: number, paidCents: number): number {
  return percentage(paidCents, principalCents);
}
