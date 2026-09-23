import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  budgets,
  categories,
  expenseGroups,
  movementReceipts,
  loanPayments,
  loans,
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

describe("migration 0007 (quick capture invariants)", () => {
  let db: PgliteDatabase;
  let client: PGlite;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
  });

  afterAll(async () => {
    await client.close();
  });

  it("completed movements require amount + category; pending rows are exempt", async () => {
    const [user] = await db
      .insert(users)
      .values({ username: "u11", passwordHash: "h", name: "U11" })
      .returning();
    const [category] = await db
      .insert(categories)
      .values({ name: "C11", kind: "expense" })
      .returning();

    // Completed without category → rejected by the category CHECK.
    await expectPgError(
      db.insert(transactions).values({ amountCents: 100, type: "expense", memberId: user.id }),
      "23514",
    );
    // Completed with a 0 amount → rejected by the amount CHECK.
    await expectPgError(
      db.insert(transactions).values({
        amountCents: 0,
        type: "expense",
        categoryId: category.id,
        memberId: user.id,
      }),
      "23514",
    );
    // Pending with 0 and no category → legal (quick capture).
    const [pending] = await db
      .insert(transactions)
      .values({ amountCents: 0, type: "expense", memberId: user.id, needsDetails: true })
      .returning();
    expect(pending.categoryId).toBeNull();
    expect(pending.needsDetails).toBe(true);
  });

  it("deleting a movement cascades to its receipt", async () => {
    const [user] = await db
      .insert(users)
      .values({ username: "u12", passwordHash: "h", name: "U12" })
      .returning();
    const [pending] = await db
      .insert(transactions)
      .values({ amountCents: 0, type: "expense", memberId: user.id, needsDetails: true })
      .returning();
    await db.insert(movementReceipts).values({
      transactionId: pending.id,
      bytes: Buffer.from([1, 2, 3]),
      mimeType: "image/png",
    });

    await db.delete(transactions).where(eq(transactions.id, pending.id));

    const remaining = await db
      .select()
      .from(movementReceipts)
      .where(eq(movementReceipts.transactionId, pending.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("migration 0006 (loans invariants)", () => {
  let db: PgliteDatabase;
  let client: PGlite;
  let memberId: string;
  let loanId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    const [user] = await db
      .insert(users)
      .values({ username: "u10", passwordHash: "h", name: "U10" })
      .returning();
    memberId = user.id;
    const [loan] = await db
      .insert(loans)
      .values({
        name: "Visa",
        kind: "credit_card",
        entity: "Banco Nación",
        scope: "common",
        principalCents: 85_000_000,
        annualRateBp: 4500,
      })
      .returning();
    loanId = loan.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("rejects an individual loan without a member via CHECK", async () => {
    await expectPgError(
      db
        .insert(loans)
        .values({ name: "Huerfana", kind: "other", entity: "X", scope: "individual", principalCents: 100 }),
      "23514",
    );
    const [ok] = await db
      .insert(loans)
      .values({ name: "Con dueño", kind: "other", entity: "X", scope: "individual", memberId, principalCents: 100 })
      .returning();
    expect(ok.memberId).toBe(memberId);
  });

  it("rejects non-positive principals and out-of-bounds rates via CHECK", async () => {
    for (const bad of [0, -100]) {
      await expectPgError(
        db.insert(loans).values({ name: "X", kind: "other", entity: "X", scope: "common", principalCents: bad }),
        "23514",
      );
    }
    await expectPgError(
      db.insert(loans).values({ name: "X", kind: "other", entity: "X", scope: "common", principalCents: 1, annualRateBp: 100001 }),
      "23514",
    );
    const [zeroRate] = await db
      .insert(loans)
      .values({ name: "Sin tasa", kind: "mortgage", entity: "Banco", scope: "common", principalCents: 1, annualRateBp: null })
      .returning();
    expect(zeroRate.annualRateBp).toBeNull();
  });

  it("accepts interest rows only without a member (CHECK both directions)", async () => {
    await expectPgError(
      db.insert(loanPayments).values({ loanId, memberId, kind: "interest", amountCents: 100, date: "2026-09-01" }),
      "23514",
    );
    const [row] = await db
      .insert(loanPayments)
      .values({ loanId, memberId: null, kind: "interest", amountCents: 100, date: "2026-09-01" })
      .returning();
    expect(row.memberId).toBeNull();
  });

  it("requires a member on payments; payments are strictly positive (CHECK)", async () => {
    await expectPgError(
      db.insert(loanPayments).values({ loanId, memberId: null, kind: "payment", amountCents: 100, date: "2026-09-01" }),
      "23514",
    );
    for (const bad of [0, -50]) {
      await expectPgError(
        db.insert(loanPayments).values({ loanId, memberId, kind: "payment", amountCents: bad, date: "2026-09-01" }),
        "23514",
      );
    }
    // Interest is signed: a negative balance true-up is legal.
    const [adjust] = await db
      .insert(loanPayments)
      .values({ loanId, memberId: null, kind: "interest", amountCents: -50, date: "2026-09-02" })
      .returning();
    expect(adjust.amountCents).toBe(-50);
  });

  it("allows one interest entry per loan/month/cause; payments repeat freely (unique index)", async () => {
    const [first] = await db
      .insert(loanPayments)
      .values({
        loanId, memberId: null, kind: "interest", amountCents: 555, date: "2026-09-01", note: "Interés 45% TNA",
      })
      .returning();
    expect(first.note).toBe("Interés 45% TNA");
    await expectPgError(
      db.insert(loanPayments).values({
        loanId, memberId: null, kind: "interest", amountCents: 999, date: "2026-09-01", note: "Interés 45% TNA",
      }),
      "23505",
    );
    // Same month, different cause (true-up) → allowed.
    const [adjust] = await db
      .insert(loanPayments)
      .values({ loanId, memberId: null, kind: "interest", amountCents: 100, date: "2026-09-01", note: "Ajuste de saldo" })
      .returning();
    expect(adjust.note).toBe("Ajuste de saldo");
    // Two payments on the same day are normal.
    for (const amountCents of [100, 200]) {
      const [row] = await db
        .insert(loanPayments)
        .values({ loanId, memberId, kind: "payment", amountCents, date: "2026-09-03" })
        .returning();
      expect(row.kind).toBe("payment");
    }
  });

  it("RESTRICTs loan deletion while payments exist", async () => {
    await expectPgError(db.delete(loans).where(eq(loans.id, loanId)), "23001");
  });

  it("cascades mirror deletion from the payment (FK ON DELETE CASCADE)", async () => {
    const [category] = await db
      .insert(categories)
      .values({ name: "Pago de préstamos (cascade)", kind: "expense" })
      .returning();
    const [payment] = await db
      .insert(loanPayments)
      .values({ loanId, memberId, kind: "payment", amountCents: 500, date: "2026-09-04" })
      .returning();
    const [mirror] = await db
      .insert(transactions)
      .values({
        amountCents: 500,
        type: "expense",
        categoryId: category.id,
        memberId,
        loanPaymentId: payment.id,
      })
      .returning();

    await db.delete(loanPayments).where(eq(loanPayments.id, payment.id));

    const remaining = await db.select().from(transactions).where(eq(transactions.id, mirror.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("migration 0008 (bolsas de ahorro invariants)", () => {
  let db: PgliteDatabase;
  let client: PGlite;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
  });

  afterAll(async () => {
    await client.close();
  });

  it("dropped the envelopes table and the transactions.envelope_id column", async () => {
    // The table is gone: selecting from it must fail as a SQL error.
    await expect(
      db.execute(sql`select * from envelopes`),
    ).rejects.toThrow();
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'transactions'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("envelope_id");
  });

  it("round-trips accrual_mode (enum) and rate_reviewed_month on savings_goals", async () => {
    const [simple] = await db
      .insert(savingsGoals)
      .values({
        name: "Simple",
        kind: "savings",
        scope: "common",
        annualRateBp: 3550,
        accrualMode: "simple",
        rateReviewedMonth: "2026-09-01",
      })
      .returning();
    expect(simple.accrualMode).toBe("simple");
    expect(simple.rateReviewedMonth).toBe("2026-09-01");

    const [compound] = await db
      .insert(savingsGoals)
      .values({
        name: "Compuesta",
        kind: "savings",
        scope: "common",
        annualRateBp: 1200,
        accrualMode: "compound",
      })
      .returning();
    expect(compound.accrualMode).toBe("compound");

    // No rate → both review columns nullable.
    const [plain] = await db
      .insert(savingsGoals)
      .values({ name: "Sin tasa", kind: "savings", scope: "common" })
      .returning();
    expect(plain.accrualMode).toBeNull();
    expect(plain.rateReviewedMonth).toBeNull();
  });

  it("rejects accrual_mode values outside the enum", async () => {
    await expectPgError(
      db.execute(
        sql`insert into savings_goals (name, kind, scope, accrual_mode) values ('X', 'savings', 'common', 'weird')`,
      ),
      "22P02",
    );
  });
});
