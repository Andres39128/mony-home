import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  budgets,
  categories,
  envelopes,
  expenseGroups,
  savingsContributions,
  savingsGoals,
  transactions,
  users,
} from "@/db/schema";
import { createTestDb, expectPgError } from "@/db/test-utils";

/**
 * These tests run against in-memory Postgres (PGlite) with the generated
 * migrations applied — they prove the SQL migration actually builds a schema
 * that enforces the household finance model's invariants.
 */

describe("schema (migrations applied to in-memory Postgres)", () => {
  let db: PgliteDatabase;
  let client: PGlite;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
  });

  afterAll(async () => {
    // PGlite holds a wasm instance; close it so vitest exits cleanly.
    await client.close();
  });

  it("round-trips a valid transaction with defaults applied", async () => {
    const [user] = await db.insert(users).values({ username: "andres", passwordHash: "h", name: "Andrés" }).returning();
    const [category] = await db
      .insert(categories)
      .values({ name: "Supermercado", kind: "expense" })
      .returning();

    const [tx] = await db
      .insert(transactions)
      .values({ amountCents: 150075, type: "expense", categoryId: category.id, memberId: user.id })
      .returning();

    expect(tx.id).toBeDefined();
    expect(tx.amountCents).toBe(150075);
    expect(tx.scope).toBe("common"); // default scope
    expect(tx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date mode 'string', defaults to CURRENT_DATE
    expect(tx.createdAt).toBeInstanceOf(Date);
    expect(tx.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects transactions with amount_cents <= 0 via CHECK", async () => {
    const [user] = await db.insert(users).values({ username: "u1", passwordHash: "h", name: "U1" }).returning();
    const [category] = await db.insert(categories).values({ name: "C1", kind: "expense" }).returning();

    for (const bad of [0, -100]) {
      await expectPgError(
        db.insert(transactions).values({
          amountCents: bad,
          type: "expense",
          categoryId: category.id,
          memberId: user.id,
        }),
        "23514",
      );
    }
  });

  it("rejects deleting a category or user referenced by a transaction (RESTRICT)", async () => {
    const [user] = await db.insert(users).values({ username: "u2", passwordHash: "h", name: "U2" }).returning();
    const [category] = await db.insert(categories).values({ name: "C2", kind: "expense" }).returning();
    await db.insert(transactions).values({
      amountCents: 100,
      type: "expense",
      categoryId: category.id,
      memberId: user.id,
    });

    // Postgres raises restrict_violation (23001) for ON DELETE RESTRICT;
    // plain no-action FKs raise 23503 instead.
    await expectPgError(db.delete(categories).where(eq(categories.id, category.id)), "23001");
    await expectPgError(db.delete(users).where(eq(users.id, user.id)), "23001");
  });

  it("sets group_id to NULL when a referenced expense group is deleted (SET NULL)", async () => {
    const [user] = await db.insert(users).values({ username: "u3", passwordHash: "h", name: "U3" }).returning();
    const [category] = await db.insert(categories).values({ name: "C3", kind: "expense" }).returning();
    const [group] = await db.insert(expenseGroups).values({ name: "Vacaciones 2026" }).returning();
    const [tx] = await db
      .insert(transactions)
      .values({
        amountCents: 200,
        type: "expense",
        categoryId: category.id,
        memberId: user.id,
        groupId: group.id,
      })
      .returning();

    await db.delete(expenseGroups).where(eq(expenseGroups.id, group.id));

    const [after] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(after.groupId).toBeNull();
  });

  it("rejects duplicate budgets for the same month and category", async () => {
    const [category] = await db.insert(categories).values({ name: "C4", kind: "expense" }).returning();
    const month = "2026-09-01";
    await db.insert(budgets).values({ month, categoryId: category.id, amountCents: 50000 });

    await expectPgError(
      db.insert(budgets).values({ month, categoryId: category.id, amountCents: 60000 }),
      "23505",
    );
  });

  it("rejects an individual envelope without a member via CHECK", async () => {
    await expectPgError(
      db.insert(envelopes).values({ name: "Huerfa", scope: "individual", memberId: null }),
      "23514",
    );

    // Sanity: an individual envelope WITH a member passes the CHECK.
    const [user] = await db.insert(users).values({ username: "u4", passwordHash: "h", name: "U4" }).returning();
    const [envelope] = await db
      .insert(envelopes)
      .values({ name: "Plata de U4", scope: "individual", memberId: user.id })
      .returning();
    expect(envelope.monthlyAmountCents).toBe(0); // default
  });

  it("rejects negative budgets via CHECK", async () => {
    const [category] = await db.insert(categories).values({ name: "C5", kind: "expense" }).returning();
    await expectPgError(
      db.insert(budgets).values({ month: "2026-09-01", categoryId: category.id, amountCents: -1 }),
      "23514",
    );
  });

  it("stores savings targets beyond int4 range (bigint money columns)", async () => {
    const [goal] = await db
      .insert(savingsGoals)
      .values({ name: "Fondo de imprevistos", kind: "savings", scope: "common", targetCents: 3_600_000_000 })
      .returning();
    expect(goal.targetCents).toBe(3_600_000_000);
  });
});

describe("migration 0005 (savings realism invariants)", () => {
  let db: PgliteDatabase;
  let client: PGlite;
  let memberId: string;
  let goalId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    const [user] = await db
      .insert(users)
      .values({ username: "u9", passwordHash: "h", name: "U9" })
      .returning();
    memberId = user.id;
    const [goal] = await db
      .insert(savingsGoals)
      .values({ name: "Con tasa", kind: "investment", scope: "common", annualRateBp: 3550 })
      .returning();
    goalId = goal.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("accepts interest rows only without a member (CHECK both directions)", async () => {
    // interest + member → rejected; interest without member → accepted.
    await expectPgError(
      db.insert(savingsContributions).values({
        goalId,
        memberId,
        kind: "interest",
        amountCents: 100,
        date: "2026-09-01",
      }),
      "23514",
    );
    const [row] = await db
      .insert(savingsContributions)
      .values({ goalId, memberId: null, kind: "interest", amountCents: 100, date: "2026-09-01" })
      .returning();
    expect(row.memberId).toBeNull();
  });

  it("requires a member on deposits and withdrawals (CHECK both directions)", async () => {
    for (const kind of ["deposit", "withdrawal"] as const) {
      await expectPgError(
        db.insert(savingsContributions).values({
          goalId,
          memberId: null,
          kind,
          amountCents: 100,
          date: "2026-09-01",
        }),
        "23514",
      );
    }
    await expectPgError(
      // Plain amounts stay positive on non-interest rows.
      db.insert(savingsContributions).values({
        goalId,
        memberId,
        kind: "deposit",
        amountCents: -50,
        date: "2026-09-01",
      }),
      "23514",
    );
  });

  it("bounds annual_rate_bp to 0..100000 via CHECK", async () => {
    await expectPgError(
      db.insert(savingsGoals).values({ name: "X", kind: "savings", scope: "common", annualRateBp: 100001 }),
      "23514",
    );
    await expectPgError(
      db.insert(savingsGoals).values({ name: "Y", kind: "savings", scope: "common", annualRateBp: -1 }),
      "23514",
    );
    const [zero] = await db
      .insert(savingsGoals)
      .values({ name: "Z0", kind: "savings", scope: "common", annualRateBp: 0 })
      .returning();
    expect(zero.annualRateBp).toBe(0);
    const [max] = await db
      .insert(savingsGoals)
      .values({ name: "ZM", kind: "savings", scope: "common", annualRateBp: 100000 })
      .returning();
    expect(max.annualRateBp).toBe(100000);
  });

  it("allows one interest entry per goal/month/cause (unique index)", async () => {
    await db.insert(savingsContributions).values({
      goalId,
      memberId: null,
      kind: "interest",
      amountCents: 555,
      date: "2026-09-01",
      note: "Interés 35,5% TNA",
    });
    await expectPgError(
      db.insert(savingsContributions).values({
        goalId,
        memberId: null,
        kind: "interest",
        amountCents: 999,
        date: "2026-09-01",
        note: "Interés 35,5% TNA",
      }),
      "23505",
    );
    // Same month, different cause (true-up) → allowed.
    const [adjust] = await db
      .insert(savingsContributions)
      .values({
        goalId,
        memberId: null,
        kind: "interest",
        amountCents: 100,
        date: "2026-09-01",
        note: "Ajuste de valoración",
      })
      .returning();
    expect(adjust.note).toBe("Ajuste de valoración");
    // Deposits are never touched by the partial index.
    const [second] = await db
      .insert(savingsContributions)
      .values({ goalId, memberId, kind: "deposit", amountCents: 100, date: "2026-09-01" })
      .returning();
    expect(second.kind).toBe("deposit");
  });

  it("cascades mirror deletion from the contribution (FK ON DELETE CASCADE)", async () => {
    const [category] = await db
      .insert(categories)
      .values({ name: "Ahorro e inversión (cascade)", kind: "expense" })
      .returning();
    const [contribution] = await db
      .insert(savingsContributions)
      .values({ goalId, memberId, kind: "deposit", amountCents: 500, date: "2026-09-02" })
      .returning();
    const [mirror] = await db
      .insert(transactions)
      .values({
        amountCents: 500,
        type: "expense",
        categoryId: category.id,
        memberId,
        savingsContributionId: contribution.id,
      })
      .returning();

    await db.delete(savingsContributions).where(eq(savingsContributions.id, contribution.id));

    const remaining = await db.select().from(transactions).where(eq(transactions.id, mirror.id));
    expect(remaining).toHaveLength(0);
  });
});
