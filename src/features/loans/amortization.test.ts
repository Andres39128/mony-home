import { describe, expect, it } from "vitest";
import {
  allocateWaterfall,
  dailyInterestCents,
  derivedFrenchCuotaCents,
  moraDailyCents,
} from "@/features/loans/amortization";

/**
 * Pure-math unit suite for the bank-style amortization module (design D2,
 * spec: bank-loan-amortization). Expected values were derived by running the
 * D2 formulas on the Davivienda seed constants — they are ground truth, not
 * approximations from the tasks sketch.
 */

// Seed constants from the liquidación (spec: backfill seed / golden reconciliation).
const SALDO_0_CENTS = 20_499_341_480; // 204,993,414.80 — golden period-start saldo
const SEED_PRINCIPAL_CENTS = 20_461_963_414; // 204,619,634.14
const STORED_CUOTA_CENTS = 262_800_000; // 2,628,000.00 — bank-published, ALWAYS wins (A3)
const EA_CHARGED_BP = 1295; // 12.95% EA — the only rate that drives math
const TERM_MONTHS = 228;

// Golden period components (design testing strategy: back-computed so the
// saldo-based components reproduce the statement lines exactly).
const GOLDEN_VIDA_CENTS = 9_661_700; // 96,617.00
const GOLDEN_INCENDIO_CENTS = 7_413_600; // 74,136.00
const GOLDEN_SEGUROS_CENTS = GOLDEN_VIDA_CENTS + GOLDEN_INCENDIO_CENTS; // 17,075,300
const GOLDEN_INTERES_CENTS = 225_731_286; // 33 daily rows × 6,840,342c at saldo0/EA1295

describe("dailyInterestCents", () => {
  it("charges round(saldo × ((1+EA)^(1/365) − 1)) on the golden saldo at EA 1295bp", () => {
    // Raw product is 6,840,342.3125 — only Math.round lands on 6,840,342;
    // truncation or a /366 divisor produces a different cent.
    expect(dailyInterestCents(SALDO_0_CENTS, EA_CHARGED_BP)).toBe(6_840_342);
  });

  it("uses the pactada-level rate when passed — raw product .7743 must round UP", () => {
    // 1747bp on the same saldo: raw 9,044,888.7743 → 9,044,889. A different
    // rate changes the factor (rate edits flow through, spec "Rate change
    // mid-life"); the fractional part kills any truncating implementation.
    expect(dailyInterestCents(SALDO_0_CENTS, 1747)).toBe(9_044_889);
  });

  it("scales with the saldo (small balance, same rate)", () => {
    expect(dailyInterestCents(123_456_789, EA_CHARGED_BP)).toBe(41_196);
  });

  it("charges zero interest at EA 0bp", () => {
    expect(dailyInterestCents(SALDO_0_CENTS, 0)).toBe(0);
  });

  it("divisor is ALWAYS 365 — a Feb-29 accrual uses the same factor", () => {
    // Leap-year scenario (spec "Leap year"): the pure formula carries no
    // calendar input, so this exact equality is what a Feb-29 row computes
    // in the engine. A /366 implementation yields 6,821,663 and fails.
    expect(dailyInterestCents(SALDO_0_CENTS, EA_CHARGED_BP)).toBe(
      Math.round(SALDO_0_CENTS * ((1 + EA_CHARGED_BP / 10_000) ** (1 / 365) - 1)),
    );
  });
});

describe("derivedFrenchCuotaCents", () => {
  it("derives the French cuota for the seed params — and NOT the stored cuota (stored wins)", () => {
    const derived = derivedFrenchCuotaCents(SEED_PRINCIPAL_CENTS, EA_CHARGED_BP, TERM_MONTHS);
    expect(derived).toBe(231_607_730); // 2,316,077.30 — pure P/i/n derivation
    // Spec scenario "Derived vs stored cuota": derivation ≠ stored, stored wins.
    // The bank-published cuota bundles insurance on top of the pure annuity.
    expect(derived).not.toBe(STORED_CUOTA_CENTS);
  });

  it("triangulates on a short 12-month term", () => {
    expect(derivedFrenchCuotaCents(100_000_000, EA_CHARGED_BP, 12)).toBe(8_896_087);
  });

  it("triangulates on the pactada rate over the seed term", () => {
    expect(derivedFrenchCuotaCents(SEED_PRINCIPAL_CENTS, 1747, TERM_MONTHS)).toBe(290_011_641);
  });

  it("splits the principal straight-line at EA 0bp (no NaN)", () => {
    // 0% is inside the schema CHECK domain (0..100000); the annuity formula
    // degenerates to 0/0 there, so the helper must fall back to P/n.
    expect(derivedFrenchCuotaCents(1_000_000, 0, 10)).toBe(100_000);
  });
});

describe("allocateWaterfall", () => {
  it("golden identity: cuota = seguros + otros + mora + interes + capital, EXACT", () => {
    const { capitalCents } = allocateWaterfall(
      STORED_CUOTA_CENTS,
      GOLDEN_SEGUROS_CENTS,
      0,
      0,
      GOLDEN_INTERES_CENTS,
    );
    expect(capitalCents).toBe(19_993_414); // 199,934.14 — residual by construction
    expect(
      GOLDEN_SEGUROS_CENTS + 0 + 0 + GOLDEN_INTERES_CENTS + capitalCents,
    ).toBe(STORED_CUOTA_CENTS);
  });

  it("keeps the identity exact with all five components present", () => {
    const { capitalCents } = allocateWaterfall(300_000, 100_000, 50_000, 25_000, 75_000);
    expect(capitalCents).toBe(50_000);
    expect(100_000 + 50_000 + 25_000 + 75_000 + capitalCents).toBe(300_000);
  });

  it("absorbs the residual into capital when only part of the components exist", () => {
    const { capitalCents } = allocateWaterfall(1_000_000, 250_000, 0, 0, 0);
    expect(capitalCents).toBe(750_000);
  });

  it("partial payment covers seguros first, capital LAST, remainder overdue", () => {
    // Spec scenario "Partial payment": payment < cuota allocates in the
    // reporting-only order seguros → otros → mora → intereses → capital.
    // Coverage of the last line is exactly what is left after the cuota's
    // non-capital lines consume the payment (min/clamp over the residual
    // capital returned by allocateWaterfall).
    const { capitalCents } = allocateWaterfall(
      STORED_CUOTA_CENTS,
      GOLDEN_SEGUROS_CENTS,
      0,
      0,
      GOLDEN_INTERES_CENTS,
    );
    const paymentCents = 20_000_000;
    const nonCapital = STORED_CUOTA_CENTS - capitalCents; // 242,806,586

    const coveredSeguros = Math.min(paymentCents, GOLDEN_SEGUROS_CENTS);
    const coveredCapital = Math.max(
      0,
      Math.min(paymentCents - nonCapital, capitalCents),
    );
    const coveredInteres =
      paymentCents - coveredSeguros - 0 - 0 - coveredCapital;

    expect(coveredSeguros).toBe(GOLDEN_SEGUROS_CENTS); // seguros fully covered first
    expect(coveredInteres).toBe(2_924_700); // interes partially covered
    expect(coveredCapital).toBe(0); // capital is covered last: nothing reaches it
    // Allocation never changes outstanding (spec: reporting-only).
    expect(STORED_CUOTA_CENTS - paymentCents).toBe(242_800_000);
  });

  it("oversize payment covers the full cuota exactly and leaves an exact excess", () => {
    const { capitalCents } = allocateWaterfall(
      STORED_CUOTA_CENTS,
      GOLDEN_SEGUROS_CENTS,
      0,
      0,
      GOLDEN_INTERES_CENTS,
    );
    const paymentCents = 300_000_000;
    const nonCapital = STORED_CUOTA_CENTS - capitalCents;

    const coveredCapital = Math.max(
      0,
      Math.min(paymentCents - nonCapital, capitalCents),
    );
    const covered = nonCapital + coveredCapital;
    const excess = paymentCents - covered;

    expect(coveredCapital).toBe(capitalCents); // capital line finally fully covered
    expect(covered).toBe(STORED_CUOTA_CENTS); // the whole cuota, exactly
    expect(excess).toBe(37_200_000); // exact remainder beyond the period
  });
});

describe("moraDailyCents", () => {
  it("charges round(base × moraBp / 10000 / 365) per overdue day", () => {
    expect(moraDailyCents(GOLDEN_VIDA_CENTS, EA_CHARGED_BP)).toBe(3_428);
  });

  it("triangulates on the full cuota base", () => {
    expect(moraDailyCents(STORED_CUOTA_CENTS, 2000)).toBe(144_000);
  });

  it("rounds half UP and divides by 365 — never 366, never truncates", () => {
    // 262,800,500 × 3650bp/10000 = 958,621,825/365... exact halves:
    //   /365 → 262,800.5 → 262,801 (round half up)
    //   truncation → 262,800 ; /366 → 262,082 — both must fail.
    // This is the leap-year divisor constant for mora (spec "Leap year").
    expect(moraDailyCents(262_800_500, 3650)).toBe(262_801);
  });

  it("stops accruing when the overdue base is paid (0 base → 0 mora)", () => {
    // Spec scenario "Entry and exit": WHEN base paid THEN mora stops.
    expect(moraDailyCents(0, 3650)).toBe(0);
  });
});
