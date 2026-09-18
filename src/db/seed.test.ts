import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loadConfig } from "@/lib/config";
import { seedDatabase } from "@/db/seed";
import { budgets, categories, envelopes, expenseGroups, loanPayments, loans, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

/**
 * Seed runs against in-memory Postgres (PGlite) with the real migrations
 * applied, proving both modes build a consistent, idempotent dataset.
 */

describe("seedDatabase", () => {
  let db: PgliteDatabase;
  let client: PGlite;

  beforeEach(async () => {
    ({ db, client } = await createTestDb());
  });

  afterEach(async () => {
    // PGlite holds a wasm instance; close it so vitest exits cleanly.
    await client.close();
  });

  const tableCounts = async () => {
    const [userRows, categoryRows, envelopeRows, groupRows, transactionRows, budgetRows, goalRows, contributionRows, loanRows, loanPaymentRows] =
      await Promise.all([
        db.select().from(users),
        db.select().from(categories),
        db.select().from(envelopes),
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
      envelopes: envelopeRows,
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
    await seedDatabase(db, loadConfig({}));

    const counts = await tableCounts();
    expect(counts.users.map((u) => u.username).sort()).toEqual(["admin", "andres", "maria"]);
    expect(counts.categories).toHaveLength(16);
    expect(counts.envelopes).toHaveLength(2);
    expect(counts.groups).toHaveLength(1);
    expect(counts.transactions).toHaveLength(10);
    expect(counts.budgets).toHaveLength(2);
    expect(counts.goals).toHaveLength(2);
    expect(counts.contributions).toHaveLength(4);
    expect(counts.loans).toHaveLength(2);
    expect(counts.loanPayments).toHaveLength(2);
  });

  it("is idempotent in demo mode (re-run does not duplicate rows)", async () => {
    await seedDatabase(db, loadConfig({}));
    await seedDatabase(db, loadConfig({}));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(3);
    expect(counts.categories).toHaveLength(16);
    expect(counts.envelopes).toHaveLength(2);
    expect(counts.groups).toHaveLength(1);
    expect(counts.transactions).toHaveLength(10);
    expect(counts.budgets).toHaveLength(2);
    expect(counts.goals).toHaveLength(2);
    expect(counts.contributions).toHaveLength(4);
    expect(counts.loans).toHaveLength(2);
    expect(counts.loanPayments).toHaveLength(2);
  });

  it("seeds only categories + admin in production mode (SEED_DEMO_DATA=false)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false" }));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(1);
    expect(counts.users[0]?.username).toBe("admin");
    expect(counts.users[0]?.role).toBe("admin");
    expect(counts.categories).toHaveLength(16);
    expect(counts.envelopes).toHaveLength(0);
    expect(counts.groups).toHaveLength(0);
    expect(counts.transactions).toHaveLength(0);
    expect(counts.budgets).toHaveLength(0);
    expect(counts.goals).toHaveLength(0);
    expect(counts.contributions).toHaveLength(0);
    expect(counts.loans).toHaveLength(0);
    expect(counts.loanPayments).toHaveLength(0);
  });

  it("is idempotent in production mode (re-run does not duplicate rows)", async () => {
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false" }));
    await seedDatabase(db, loadConfig({ SEED_DEMO_DATA: "false" }));

    const counts = await tableCounts();
    expect(counts.users).toHaveLength(1);
    expect(counts.categories).toHaveLength(16);
    expect(counts.loans).toHaveLength(0);
  });
});
