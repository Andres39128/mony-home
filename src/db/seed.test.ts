import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loadConfig } from "@/lib/config";
import { seedDatabase } from "@/db/seed";
import { budgets, categories, expenseGroups, loanPayments, loans, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
import { catchUpAllLoanInterest } from "@/features/loans/accrual";
import type { Database } from "@/db";
import { createTestDb } from "@/db/test-utils";

/**
 * Seed runs against in-memory Postgres (PGlite) with the real migrations
 * applied, proving both modes build a consistent, idempotent dataset.
 */

/** Any ≥8-char password satisfies the schema (which no longer has a default). */
const SEED_PASSWORD = "test-password-123";
const seedConfig = () => loadConfig({ SEED_ADMIN_PASSWORD: SEED_PASSWORD });

describe("seedDatabase", () => {
  let db: PgliteDatabase;
  let client: PGlite;

  beforeEach(async () => {
    ({ db, client } = await createTestDb());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // PGlite holds a wasm instance; close it so vitest exits cleanly.
    await client.close();
  });

  const tableCounts = async () => {
    const [userRows, categoryRows, groupRows, transactionRows, budgetRows, goalRows, contributionRows, loanRows, loanPaymentRows] =
      await Promise.all([
        db.select().from(users),
        db.select().from(categories),
        db.select().from(expenseGroups),
        db.select().from(transactions),
        db.select().from(budgets),
        db.select().from(savingsGoals),
        db.select().from(savingsContributions),
        db.select().from(loans),
        db.select().from(loanPayments),
      ]);
    return {
      users: userRows,
      categories: categoryRows,
      groups: groupRows,
      transactions: transactionRows,
      budgets: budgetRows,
      goals: goalRows,
      contributions: contributionRows,
      loans: loanRows,
      loanPayments: loanPaymentRows,
    };
  };

  it("seeds full demo data when SEED_DEMO_DATA is unset (default)", async () => {
    await seedDatabase(db, seedConfig());

    const counts = await tableCounts();
    expect(counts.users.map((u) => u.username).sort()).toEqual(["admin", "andres", "maria"]);
    expect(counts.categories).toHaveLength(16);
    expect(counts.groups).toHaveLength(1);
    expect(counts.transactions).toHaveLength(10);
    expect(counts.budgets).toHaveLength(2);
    expect(counts.goals).toHaveLength(2);
    expect(counts.contributions).toHaveLength(4);
    // Two demo loans + the real Davivienda mortgage (seeded in BOTH modes).
    expect(counts.loans.map((l) => l.name).sort()).toEqual([
      "Hipoteca Davivienda",
      "Hipoteca casa",
      "Visa Banco Nación",
    ]);
    expect(counts.loanPayments).toHaveLength(2); // the mortgage seeds ZERO ledger rows

    // Both daily accrual modes are exercised by the demo bolsas.
    const fondo = counts.goals.find((g) => g.name === "Fondo de emergencia");
    expect(fondo).toMatchObject({ kind: "savings", annualRateBp: 3650, accrualMode: "simple" });
    const plazo = counts.goals.find((g) => g.name === "Plazo fijo");
    expect(plazo).toMatchObject({ kind: "investment", annualRateBp: 7000, accrualMode: "compound" });
  });

  it("is idempotent in demo mode (re-run does not duplicate rows)", async () => {
    await seedDatabase(db, seedConfig());
    await seedDatabase(db, seedConfig());

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(3);
    expect(counts.categories).toHaveLength(16);
    expect(counts.groups).toHaveLength(1);
    expect(counts.transactions).toHaveLength(10);
    expect(counts.budgets).toHaveLength(2);
    expect(counts.goals).toHaveLength(2);
    expect(counts.contributions).toHaveLength(4);
    expect(counts.loans).toHaveLength(3);
    expect(counts.loanPayments).toHaveLength(2);
  });

  it("seeds only categories + admin + the real mortgage in production mode (SEED_DEMO_DATA=false)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(1);
    expect(counts.users[0]?.username).toBe("admin");
    expect(counts.users[0]?.role).toBe("admin");
    expect(counts.categories).toHaveLength(16);
    expect(counts.groups).toHaveLength(0);
    expect(counts.transactions).toHaveLength(0);
    expect(counts.budgets).toHaveLength(0);
    expect(counts.goals).toHaveLength(0);
    expect(counts.contributions).toHaveLength(0);
    // Real data rides along like users/categories (D7): the mortgage is the
    // user's actual loan, not demo content.
    expect(counts.loans.map((l) => l.name)).toEqual(["Hipoteca Davivienda"]);
    expect(counts.loanPayments).toHaveLength(0);
  });

  it("is idempotent in production mode (re-run does not duplicate rows)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(1);
    expect(counts.categories).toHaveLength(16);
    expect(counts.loans).toHaveLength(1);
  });

  it("seeds the Davivienda mortgage with the statement calibration and ZERO ledger rows (D7)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));

    const [mortgage] = await db.select().from(loans).where(eq(loans.name, "Hipoteca Davivienda"));
    expect(mortgage).toBeDefined();
    expect(mortgage).toMatchObject({
      kind: "mortgage",
      entity: "Davivienda",
      scope: "common",
      // Principal = saldo at the last liquidación ($204.619.634,14).
      principalCents: 20_461_963_414,
      amortizationMode: "bank",
      chargedRateBp: 1295,
      contractualRateBp: 1747,
      termMonths: 228,
      fixedCuotaCents: 262_800_000,
      cuotaDay: 25,
      propertyValueCents: 33_980_260_000,
      // Back-computed per-millón calibration (golden test constants).
      lifeInsuranceRatePerMillonX100k: 47_131_758,
      fireInsuranceRatePerMillonX100k: 21_817_373,
      moraRateBp: null,
      otherChargesCents: null,
    });
    // Forward-only: the loan's created_at IS the last liquidation instant.
    expect(mortgage.createdAt).toEqual(new Date("2026-08-31T12:00:00.000Z"));
    // No history reconstruction: the mortgage seeds ZERO ledger rows.
    expect(await db.select().from(loanPayments).where(eq(loanPayments.loanId, mortgage.id))).toEqual([]);
  });

  it("nothing predates the seed: the engine accrues forward-only from the liquidation", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));
    const [mortgage] = await db.select().from(loans).where(eq(loans.name, "Hipoteca Davivienda"));

    // Deterministic `now`: one closed period past the 2026-09-25 anchor.
    await catchUpAllLoanInterest(db as unknown as Database, new Date("2026-10-05T12:00:00Z"));

    const rows = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, mortgage.id))
      .orderBy(asc(loanPayments.date));
    expect(rows.length).toBeGreaterThan(0);
    // Nothing predates the seed (spec scenario n): the earliest engine row
    // lands the day AFTER the liquidation instant.
    expect(rows[0]!.date).toBe("2026-09-01");
    // The calibrated config is live: the 09-25 close materialized the cuota
    // components on the running saldo / property value.
    const notes = rows.filter((r) => r.date === "2026-09-25").map((r) => r.note);
    expect(notes).toContain("Seguro de vida");
    expect(notes).toContain("Seguro de incendio");

    // Re-running the seed alongside engine rows changes nothing (name-keyed).
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));
    const after = await db.select().from(loans).where(eq(loans.name, "Hipoteca Davivienda"));
    expect(after).toHaveLength(1);
    const rowsAfter = await db.select().from(loanPayments).where(eq(loanPayments.loanId, mortgage.id));
    expect(rowsAfter).toHaveLength(rows.length);
  });

  it("refuses to seed in production without SEED_ALLOW_PROD=yes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEED_ALLOW_PROD", "");

    await expect(seedDatabase(db, seedConfig())).rejects.toThrow(
      "Refusing to seed in production without SEED_ALLOW_PROD=yes",
    );
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("seeds in production when SEED_ALLOW_PROD=yes is set explicitly", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEED_ALLOW_PROD", "yes");

    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("refuses to seed without SEED_ADMIN_PASSWORD (no default anymore)", async () => {
    await expect(seedDatabase(db, loadConfig({}))).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
