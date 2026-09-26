/**
 * Pure bank-style amortization math (loans.amortization_mode = 'bank') —
 * no DB, no Next.js imports; same contract as math.ts (design D2).
 *
 * All money is integer cents; rates are basis points (1 bp = 0.01% EA).
 * The daily divisor is ALWAYS 365 — leap days included (spec
 * bank-loan-amortization: "Leap year").
 */

/**
 * Daily interest accrued over the running saldo:
 * round(saldo × ((1+EA)^(1/365) − 1)) — one row per elapsed day.
 */
export function dailyInterestCents(
  saldoCents: number,
  chargedRateBp: number,
): number {
  return Math.round(
    saldoCents * ((1 + chargedRateBp / 10_000) ** (1 / 365) - 1),
  );
}

/**
 * Payment waterfall residual (seguros → otros cargos → mora → intereses →
 * capital): capital = cuota − sum(other components), so the cuota identity
 * holds EXACTLY in integer cents by construction. Allocation is
 * reporting-only — outstanding is unchanged (spec "Payment waterfall").
 */
export function allocateWaterfall(
  cuotaCents: number,
  segurosCents: number,
  otrosCents: number,
  moraCents: number,
  interesCents: number,
): { capitalCents: number } {
  return {
    capitalCents:
      cuotaCents - segurosCents - otrosCents - moraCents - interesCents,
  };
}

/**
 * Mora accrued per overdue day over the unpaid overdue base:
 * round(base × moraBp / 10000 / 365). Stops when the base is paid (0 base
 * → 0 mora).
 */
export function moraDailyCents(
  overdueBaseCents: number,
  moraRateBp: number,
): number {
  return Math.round((overdueBaseCents * moraRateBp) / 10_000 / 365);
}
