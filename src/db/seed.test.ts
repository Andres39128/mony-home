import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loadConfig } from "@/lib/config";
import { PLACEHOLDER_SEED_PASSWORD, seedDatabase } from "@/db/seed";
import { budgets, categories, expenseGroups, loanPayments, loans, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
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
    expect(counts.loans).toHaveLength(2);
    expect(counts.loanPayments).toHaveLength(2);

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
    expect(counts.loans).toHaveLength(2);
    expect(counts.loanPayments).toHaveLength(2);
  });

  it("seeds only categories + admin in production mode (SEED_DEMO_DATA=false)", async () => {
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
    expect(counts.loans).toHaveLength(0);
    expect(counts.loanPayments).toHaveLength(0);
  });

  it("is idempotent in production mode (re-run does not duplicate rows)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false", SEED_ADMIN_PASSWORD: SEED_PASSWORD }));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(1);
    expect(counts.categories).toHaveLength(16);
    expect(counts.loans).toHaveLength(0);
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

  it("refuses the old changeme placeholder password", async () => {
    await expect(
      seedDatabase(db, loadConfig({ SEED_ADMIN_PASSWORD: PLACEHOLDER_SEED_PASSWORD })),
    ).rejects.toThrow(/placeholder/);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("refuses too-short passwords (policy lives in the seed, not the env schema)", async () => {
    await expect(seedDatabase(db, loadConfig({ SEED_ADMIN_PASSWORD: "short" }))).rejects.toThrow(
      /SEED_ADMIN_PASSWORD/,
    );
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
