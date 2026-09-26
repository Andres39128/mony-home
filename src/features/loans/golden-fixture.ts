/**
 * Shared golden-fixture constants and seed helper for the loans suites
 * (spec: backfill seed / golden reconciliation). TEST-ONLY — never imported
 * from production code.
 */
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loans } from "@/db/schema";

/** Golden Davivienda statement constants (R2 Spec Amendment):
 *  saldo0 = $204.993.414,80, EA cobrada 1295 bp, cuota $2.628.000,00,
 *  33-day interest line; per-millón rates BACK-COMPUTED so the saldo-based
 *  vida = $96.617,00 and the property-based incendio = $74.136,00 exactly. */
export const GOLDEN = {
  saldo0Cents: 20_499_341_480,
  propertyCents: 33_980_260_000,
  chargedRateBp: 1295,
  contractualRateBp: 1747,
  termMonths: 228,
  cuotaCents: 262_800_000,
  days: 33,
  // Back-computed integers (round(target × 1e11 / base)); engine-exact by
  // construction: round(saldo0/1e6 × 47.131.758/1e5) = 9.661.700 etc.
  lifeRateX100k: 47_131_758,
  fireRateX100k: 21_817_373,
  vidaCents: 9_661_700,
  incendioCents: 7_413_600,
  bankStatedInterestCents: 208_346_634, // $2.083.466,34 statement line
} as const;

/** 33 daily rows × 6,840,342c at saldo0/EA1295 — the FLAT (non-compounding) sum. */
export const FLAT_33_DAY_INTEREST_CENTS = 225_731_286;
/** The engine's day-by-day compounded 33-day sum (ground truth). */
export const COMPOUNDED_33_DAY_INTEREST_CENTS = 226_940_638;

interface GoldenOverrides {
  name?: string;
  principalCents?: number;
  lifeX100k?: number;
  fireX100k?: number;
  otrosCents?: number;
  propertyCents?: number;
  moraRateBp?: number;
  createdAt?: Date;
}

/** Bank-mode loan fixture: $1.000.000 principal at 12.95% EA (golden scale via
 * overrides), cuota closing day 25, created 2026-01-10 (accrual base day =
 * creation day; first daily row is 2026-01-11). Insurance components default
 * to OFF (null = off). */
export async function seedGoldenBankLoan(
  db: PgliteDatabase,
  overrides: GoldenOverrides = {},
): Promise<string> {
  const [loan] = await db
    .insert(loans)
    .values({
      name: overrides.name ?? "Hipoteca banca",
      kind: "mortgage",
      entity: "Davivienda",
      scope: "common",
      principalCents: overrides.principalCents ?? 100_000_000,
      amortizationMode: "bank",
      chargedRateBp: GOLDEN.chargedRateBp,
      contractualRateBp: GOLDEN.contractualRateBp,
      termMonths: GOLDEN.termMonths,
      fixedCuotaCents: GOLDEN.cuotaCents,
      cuotaDay: 25,
      lifeInsuranceRatePerMillonX100k: overrides.lifeX100k ?? null,
      fireInsuranceRatePerMillonX100k: overrides.fireX100k ?? null,
      otherChargesCents: overrides.otrosCents ?? null,
      propertyValueCents: overrides.propertyCents ?? null,
      moraRateBp: overrides.moraRateBp ?? null,
      createdAt: overrides.createdAt ?? new Date("2026-01-10T12:00:00Z"),
    })
    .returning();
  return loan.id;
}
