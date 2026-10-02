import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, loans, recurringMovements, transactions, users } from "@/db/schema";
import {
  createRecurring,
  listRecurring,
  removeRecurring,
  toggleRecurringActive,
  updateRecurring,
  type RecurringInput,
} from "@/features/recurring/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Recurring CRUD suite (PGlite): admin-only mutations, category kind /
 * member status rules, the shared amount parser with movements-style
 * ambiguity discrimination ('1.234' → guided ambiguous_amount, not a
 * generic rejection), and the card-funding rules shared with movements
 * (expense-only, active revolving, cupo).
 */
describe("recurring service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;
  let inactiveMemberId: string;
  let expenseId: string;

  const baseInput: RecurringInput = {
    name: "Alquiler",
    type: "expense",
    amount: "1.234,56",
    categoryId: "",
    memberId: "",
    scope: "common",
    dayOfMonth: 5,
    frequency: "monthly",
    paymentMethod: "cash",
    cardId: "",
    note: "",
  };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [adminRow] = await db
      .insert(users)
      .values({ username: "admin", passwordHash: "x", name: "Admin", role: "admin" })
      .returning();
    const [mateRow] = await db
      .insert(users)
      .values({ username: "mate", passwordHash: "x", name: "Mate" })
      .returning();
    const [goneRow] = await db
      .insert(users)
      .values({ username: "gone", passwordHash: "x", name: "Gone", isActive: false })
      .returning();
    admin = { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: adminRow.role };
    member = { id: mateRow.id, username: mateRow.username, name: mateRow.name, role: mateRow.role };
    memberId = mateRow.id;
    inactiveMemberId = goneRow.id;

    const inserted = await db
      .insert(categories)
      .values([
        { name: "Alquiler", kind: "expense" },
        { name: "Sueldo", kind: "income" },
      ])
      .returning();
    expenseId = inserted[0].id;
  });

  afterAll(async () => {
    await client.close();
  });

  /** An active revolving card with the given cupo, unique per test. */
  async function insertCard(name: string, creditLimitCents: number): Promise<string> {
    const [card] = await db
      .insert(loans)
      .values({
        name,
        kind: "credit_card",
        entity: "Banco",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents,
      })
      .returning();
    return card.id;
  }

  it("creates with parsed cents and lists with joined labels", async () => {
    const result = await createRecurring(appDb, admin, {
      ...baseInput,
      categoryId: expenseId,
      memberId,
    });
    expect(result).toEqual({ ok: true });

    const rows = await listRecurring(appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Alquiler",
      amountCents: 123_456,
      categoryName: "Alquiler",
      memberName: "Mate",
      frequency: "monthly",
      paymentMethod: "cash",
      cardId: null,
      cardName: null,
      isActive: true,
      lastMaterializedMonth: null,
    });
  });

  it("rejects non-admins, kind mismatches, inactive members and bad amounts", async () => {
    const input = { ...baseInput, categoryId: expenseId, memberId };
    expect(await createRecurring(appDb, member, input)).toEqual({ ok: false, error: "forbidden" });
    expect(
      await createRecurring(appDb, admin, { ...input, type: "income", categoryId: expenseId }),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
    expect(
      await createRecurring(appDb, admin, { ...input, memberId: inactiveMemberId }),
    ).toEqual({ ok: false, error: "member_inactive" });
    expect(
      await createRecurring(appDb, admin, { ...input, amount: "no-vale" }),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(await createRecurring(appDb, admin, { ...input, amount: "-5" })).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    // The shared guided path: '1.234' is ambiguous, NOT silently thousands.
    expect(
      await createRecurring(appDb, admin, { ...input, amount: "1.234" }),
    ).toEqual({ ok: false, error: "ambiguous_amount" });
  });

  it("updates fields and reports not_found for stale ids", async () => {
    const [created] = await db
      .select()
      .from(recurringMovements)
      .where(eq(recurringMovements.name, "Alquiler"));
    expect(
      await updateRecurring(appDb, admin, created.id, {
        ...baseInput,
        name: "Alquiler depto",
        amount: "1.500,00",
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: true });

    const [updated] = await db.select().from(recurringMovements).where(eq(recurringMovements.id, created.id));
    expect(updated.name).toBe("Alquiler depto");
    expect(updated.amountCents).toBe(150_000);

    expect(
      await updateRecurring(appDb, admin, "00000000-0000-0000-0000-000000000000", {
        ...baseInput,
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("toggles isActive (pause/resume)", async () => {
    const [created] = await db
      .select()
      .from(recurringMovements)
      .where(eq(recurringMovements.name, "Alquiler depto"));
    expect(await toggleRecurringActive(appDb, admin, created.id)).toEqual({ ok: true });
    let [row] = await db.select().from(recurringMovements).where(eq(recurringMovements.id, created.id));
    expect(row.isActive).toBe(false);
    await toggleRecurringActive(appDb, admin, created.id);
    [row] = await db.select().from(recurringMovements).where(eq(recurringMovements.id, created.id));
    expect(row.isActive).toBe(true);
  });

  it("removes even with materialized movements: the FK nulls recurring_id", async () => {
    const [created] = await db
      .select()
      .from(recurringMovements)
      .where(eq(recurringMovements.name, "Alquiler depto"));
    // A movement the catch-up would have generated.
    await db.insert(transactions).values({
      date: "2026-09-05",
      amountCents: 150_000,
      type: "expense",
      categoryId: expenseId,
      memberId,
      note: "Alquiler depto",
      recurringId: created.id,
    });

    expect(await removeRecurring(appDb, admin, created.id)).toEqual({ ok: true });

    const kept = await db.select().from(transactions).where(eq(transactions.note, "Alquiler depto"));
    expect(kept).toHaveLength(1);
    expect(kept[0].recurringId).toBeNull();
    expect(await db.select().from(recurringMovements)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // F3: frequencies + card-funded recurrings
  // ---------------------------------------------------------------------------

  it("persists frequency and card funding; list exposes them with the card name", async () => {
    const cardId = await insertCard("Visa rec", 1_000_000);
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        name: "Netflix con tarjeta",
        frequency: "weekly",
        paymentMethod: "card",
        cardId,
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(recurringMovements)
      .where(eq(recurringMovements.name, "Netflix con tarjeta"));
    expect(row.frequency).toBe("weekly");
    expect(row.paymentMethod).toBe("card");
    expect(row.cardLoanId).toBe(cardId);

    const view = (await listRecurring(appDb)).find((r) => r.name === "Netflix con tarjeta")!;
    expect(view.frequency).toBe("weekly");
    expect(view.cardId).toBe(cardId);
    expect(view.cardName).toBe("Visa rec");
  });

  it("rejects card funding on income recurrings (expense-only, shared rule)", async () => {
    const cardId = await insertCard("Visa ingreso", 1_000_000);
    const [income] = await db
      .select()
      .from(categories)
      .where(eq(categories.name, "Sueldo"));
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        type: "income",
        categoryId: income.id,
        paymentMethod: "card",
        cardId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "card_requires_expense" });
  });

  it("rejects card funding with unknown, inactive or non-revolving cards", async () => {
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        paymentMethod: "card",
        cardId: "00000000-0000-0000-0000-000000000000",
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "card_not_found" });

    const inactiveId = await insertCard("Visa baja", 1_000_000);
    await db.update(loans).set({ isActive: false }).where(eq(loans.id, inactiveId));
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        paymentMethod: "card",
        cardId: inactiveId,
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "card_inactive" });

    // A bank-style (non-revolving) loan is not a payment card.
    const [bank] = await db
      .insert(loans)
      .values({
        name: "Hipoteca",
        kind: "mortgage",
        entity: "Banco",
        scope: "common",
        principalCents: 10_000_000,
        amortizationMode: "bank",
        chargedRateBp: 800,
        fixedCuotaCents: 500_000,
        termMonths: 240,
        cuotaDay: 10,
      })
      .returning();
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        paymentMethod: "card",
        cardId: bank.id,
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "card_not_revolving" });
  });

  it("rejects card funding above the cupo (card_limit_exceeded)", async () => {
    const cardId = await insertCard("Visa chiquita", 50_000);
    expect(
      await createRecurring(appDb, admin, {
        ...baseInput,
        amount: "600",
        paymentMethod: "card",
        cardId,
        categoryId: expenseId,
        memberId,
      }),
    ).toEqual({ ok: false, error: "card_limit_exceeded" });
  });
});
