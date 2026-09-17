import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { budgets, categories, envelopes, expenseGroups, transactions, users } from "@/db/schema";
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
});
