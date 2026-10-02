import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { loans, recurringMovements, transactions, users, categories } from "@/db/schema";
import { catchUpRecurringMovements } from "@/features/recurring/catch-up";
import { removeRecurring } from "@/features/recurring/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Lazy materialization suite (PGlite, injectable `now`) for ALL frequencies:
 * - monthly: one transaction per elapsed month, dated dayOfMonth,
 * - weekly: one transaction per creation-weekday date (intra-month fresh),
 * - annual: one per year on dayOfMonth of the creation month,
 * - the CREATION occurrence never materializes ("base day doesn't accrue"),
 * - the current period waits for its day (no future-dated rows),
 * - dayOfMonth caps at 28 because February is the shortest month: every
 *   month is guaranteed to have day 28, so no date clamping is ever needed
 *   (a 31-style day would need per-month clamping — the CHECK forbids it),
 * - card-funded rows carry payment_method/card_loan_id and respect the cupo.
 */

function makeAdmin(row: { id: string; username: string; name: string; role: "admin" | "member" }): SessionUser {
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

/** Proxy that counts how many times db.transaction is opened. */
function countingDb(db: Database): { db: Database; count: () => number } {
  let calls = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") calls++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy, count: () => calls };
}

describe("catchUpRecurringMovements (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let memberId: string;
  let expenseId: string;

  async function insertRecurring(
    values: Partial<typeof recurringMovements.$inferInsert> & { name: string },
  ) {
    const [row] = await db
      .insert(recurringMovements)
      .values({
        type: "expense",
        amountCents: 12_345,
        categoryId: expenseId,
        memberId,
        dayOfMonth: 5,
        ...values,
      })
      .returning();
    return row;
  }

  async function materializedRows() {
    return db.select().from(transactions).orderBy(asc(transactions.date));
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [user] = await db
      .insert(users)
      .values({ username: "member", passwordHash: "x", name: "Member" })
      .returning();
    memberId = user.id;
    const [category] = await db
      .insert(categories)
      .values({ name: "Alquiler", kind: "expense" })
      .returning();
    expenseId = category.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("materializes back-months on first catch-up, skipping the creation month", async () => {
    const recurring = await insertRecurring({
      name: "Alquiler",
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    expect(inserted).toBe(3); // Jul, Aug, Sep — June (creation month) never materializes

    const rows = await materializedRows();
    expect(rows.map((row) => row.date)).toEqual(["2026-07-05", "2026-08-05", "2026-09-05"]);
    expect(rows.every((row) => row.recurringId === recurring.id)).toBe(true);
    expect(rows.every((row) => row.note === "Alquiler")).toBe(true);
    expect(rows.every((row) => row.needsDetails === false)).toBe(true);
    expect(rows.every((row) => row.amountCents === 12_345)).toBe(true);

    const [pointer] = await db
      .select({ last: recurringMovements.lastMaterializedMonth })
      .from(recurringMovements)
      .where(eq(recurringMovements.id, recurring.id));
    expect(pointer.last).toBe("2026-09-01");
  });

  it("dayOfMonth 28 lands on Feb 28 (1..28 needs no clamping — Feb defines the cap)", async () => {
    const recurring = await insertRecurring({
      name: "Cuota",
      dayOfMonth: 28,
      createdAt: new Date("2026-01-15T12:00:00Z"),
    });

    // now = March 1st: February materializes, March waits for its day 28.
    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-03-01T12:00:00Z"));
    expect(inserted).toBe(1);
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows.map((row) => row.date)).toEqual(["2026-02-28"]);
  });

  it("waits for dayOfMonth, and the creation month never materializes", async () => {
    const recurring = await insertRecurring({
      name: "Suscripción",
      dayOfMonth: 25,
      createdAt: new Date("2026-09-01T12:00:00Z"),
    });
    const rowsFor = async () =>
      db.select().from(transactions).where(eq(transactions.recurringId, recurring.id));

    // Sep 23 < day 25 → nothing yet.
    await catchUpRecurringMovements(appDb, new Date("2026-09-23T12:00:00Z"));
    expect(await rowsFor()).toHaveLength(0);

    // On the day itself STILL nothing: the creation month never materializes
    // (first materialization = the month after creation, decided semantics).
    await catchUpRecurringMovements(appDb, new Date("2026-09-25T12:00:00Z"));
    expect(await rowsFor()).toHaveLength(0);

    // Next month's day 25 lands on the dot.
    await catchUpRecurringMovements(appDb, new Date("2026-10-25T12:00:00Z"));
    const rows = await rowsFor();
    expect(rows.map((row) => row.date)).toEqual(["2026-10-25"]);
  });

  it("is idempotent: a re-run inserts nothing (no dupes)", async () => {
    const recurring = await insertRecurring({
      name: "Sueldo",
      type: "income",
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    const second = await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    expect(second).toBe(0);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows).toHaveLength(3);
  });

  it("a paused recurring (isActive=false) does not materialize", async () => {
    const recurring = await insertRecurring({
      name: "Pausado",
      isActive: false,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows).toHaveLength(0);
  });

  it("deleting a recurring keeps its movements with recurring_id nulled (FK SET NULL)", async () => {
    const recurring = await insertRecurring({
      name: "Eliminar",
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });
    await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));

    const admin = makeAdmin({
      id: memberId,
      username: "member",
      name: "Member",
      role: "admin",
    });
    expect(await removeRecurring(appDb, admin, recurring.id)).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows).toHaveLength(0);
    const kept = await db.select().from(transactions).where(eq(transactions.note, "Eliminar"));
    expect(kept).toHaveLength(3);
    expect(kept.every((row) => row.recurringId === null)).toBe(true);
  });

  it("cold path opens no write transaction in steady state", async () => {
    // Settle every recurring first, then a fresh run must be a pure read.
    await catchUpRecurringMovements(appDb, new Date("2026-09-30T12:00:00Z"));
    const { db: counted, count } = countingDb(appDb);
    const inserted = await catchUpRecurringMovements(counted, new Date("2026-09-30T12:00:00Z"));
    expect(inserted).toBe(0);
    expect(count()).toBe(0);
  });

  it("deactivated category: skips materialization, advances the pointer, no backfill on reactivation", async () => {
    const [inactiveCategory] = await db
      .insert(categories)
      .values({ name: "Categoría baja", kind: "expense" })
      .returning();
    const recurring = await insertRecurring({
      name: "Con categoría baja",
      categoryId: inactiveCategory.id,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });
    await db
      .update(categories)
      .set({ isActive: false })
      .where(eq(categories.id, inactiveCategory.id));
    const rowsFor = async () =>
      db.select().from(transactions).where(eq(transactions.recurringId, recurring.id));

    // Pending months exist, but nothing materializes while the category is off.
    await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    expect(await rowsFor()).toHaveLength(0);
    const [pointer] = await db
      .select({ last: recurringMovements.lastMaterializedMonth })
      .from(recurringMovements)
      .where(eq(recurringMovements.id, recurring.id));
    expect(pointer.last).toBe("2026-09-01"); // advanced anyway

    // Reactivating covers only FUTURE months: Sep stays skipped (decision:
    // no silent backfill), Oct materializes.
    await db
      .update(categories)
      .set({ isActive: true })
      .where(eq(categories.id, inactiveCategory.id));
    await catchUpRecurringMovements(appDb, new Date("2026-10-10T12:00:00Z"));
    const resumedRows = await rowsFor();
    expect(resumedRows.map((row) => row.date)).toEqual(["2026-10-05"]);
  });

  it("deactivated member: skips materialization and advances the pointer", async () => {
    const [ghost] = await db
      .insert(users)
      .values({ username: "ghost", passwordHash: "x", name: "Ghost" })
      .returning();
    const recurring = await insertRecurring({
      name: "De fantasma",
      memberId: ghost.id,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });
    await db.update(users).set({ isActive: false }).where(eq(users.id, ghost.id));

    await catchUpRecurringMovements(appDb, new Date("2026-09-10T12:00:00Z"));
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows).toHaveLength(0);
    const [pointer] = await db
      .select({ last: recurringMovements.lastMaterializedMonth })
      .from(recurringMovements)
      .where(eq(recurringMovements.id, recurring.id));
    expect(pointer.last).toBe("2026-09-01"); // advanced anyway

    // Restore so later runs behave (state hygiene for the shared DB).
    await db.update(users).set({ isActive: true }).where(eq(users.id, ghost.id));
  });

  // ---------------------------------------------------------------------------
  // F3: weekly + annual frequencies and card-funded materializations
  // ---------------------------------------------------------------------------

  it("weekly: materializes every creation-weekday occurrence since creation", async () => {
    // 2026-07-08 is a Wednesday → occurrences are the following Wednesdays.
    const recurring = await insertRecurring({
      name: "Semanal",
      frequency: "weekly",
      createdAt: new Date("2026-07-08T12:00:00Z"),
    });

    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-08-12T12:00:00Z"));
    expect(inserted).toBe(5); // 07-15, 07-22, 07-29, 08-05, 08-12 (creation week skips)

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id))
      .orderBy(asc(transactions.date));
    expect(rows.map((row) => row.date)).toEqual([
      "2026-07-15",
      "2026-07-22",
      "2026-07-29",
      "2026-08-05",
      "2026-08-12",
    ]);
  });

  it("weekly: lands on its day mid-month, replays absorbed by the unique index", async () => {
    const recurring = await insertRecurring({
      name: "Semanalpro",
      frequency: "weekly",
      createdAt: new Date("2026-07-08T12:00:00Z"),
    });
    // First read on 2026-08-05: materializes through that Wednesday.
    await catchUpRecurringMovements(appDb, new Date("2026-08-05T12:00:00Z"));

    // A read one week later materializes ONLY the new occurrence — the
    // replay of the open month's earlier dates inserts nothing.
    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-08-13T12:00:00Z"));
    expect(inserted).toBe(1); // 08-12 (13th's read misses nothing else)

    // Same-day re-read: steady state, nothing new.
    const again = await catchUpRecurringMovements(appDb, new Date("2026-08-13T12:00:00Z"));
    expect(again).toBe(0);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id))
      .orderBy(asc(transactions.date));
    expect(rows.map((row) => row.date)).toEqual([
      "2026-07-15",
      "2026-07-22",
      "2026-07-29",
      "2026-08-05",
      "2026-08-12",
    ]);
  });

  it("annual: one occurrence per year on the creation month's dayOfMonth", async () => {
    const recurring = await insertRecurring({
      name: "Anual",
      frequency: "annual",
      dayOfMonth: 5,
      createdAt: new Date("2026-03-10T12:00:00Z"),
    });

    // now = April 2028: the 2026 creation year never materializes; the
    // 2028-03 anniversary landed (day 5 < April). The global count is not
    // asserted — older monthlies in this shared DB backfill too.
    await catchUpRecurringMovements(appDb, new Date("2028-04-10T12:00:00Z"));

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id))
      .orderBy(asc(transactions.date));
    expect(rows.map((row) => row.date)).toEqual(["2027-03-05", "2028-03-05"]);
  });

  it("annual: the current year waits for its dayOfMonth", async () => {
    const recurring = await insertRecurring({
      name: "Anual temprano",
      frequency: "annual",
      dayOfMonth: 25,
      createdAt: new Date("2026-03-10T12:00:00Z"),
    });
    const rowsFor = async () =>
      db.select().from(transactions).where(eq(transactions.recurringId, recurring.id));

    // 2027-03-25 hasn't happened by 2027-03-10 → the 2027 anniversary
    // must wait: nothing materializes for THIS recurring yet.
    await catchUpRecurringMovements(appDb, new Date("2027-03-10T12:00:00Z"));
    expect(await rowsFor()).toHaveLength(0);

    await catchUpRecurringMovements(appDb, new Date("2027-03-25T12:00:00Z"));
    const rows = await rowsFor();
    expect(rows.map((row) => row.date)).toEqual(["2027-03-25"]);
  });

  it("card-paid: materialized rows carry the card and consume its cupo", async () => {
    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa catch",
        kind: "credit_card",
        entity: "Banco",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents: 50_000,
      })
      .returning();
    const recurring = await insertRecurring({
      name: "Con tarjeta",
      paymentMethod: "card",
      cardLoanId: card.id,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-08-10T12:00:00Z"));
    expect(inserted).toBe(2); // Jul 5 + Aug 5

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows.every((row) => row.paymentMethod === "card")).toBe(true);
    expect(rows.every((row) => row.cardLoanId === card.id)).toBe(true);
  });

  it("card-paid: a batch above the cupo is skipped but the pointer advances (no backfill)", async () => {
    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa llena",
        kind: "credit_card",
        entity: "Banco",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents: 10_000,
      })
      .returning();
    const recurring = await insertRecurring({
      name: "Sin cupo",
      paymentMethod: "card",
      cardLoanId: card.id,
      amountCents: 8_000,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    // Jul 5 + Aug 5 = 16.000 > 10.000 cupo → the batch is rejected.
    const inserted = await catchUpRecurringMovements(appDb, new Date("2026-08-10T12:00:00Z"));
    expect(inserted).toBe(0);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringId, recurring.id));
    expect(rows).toHaveLength(0);
    const [pointer] = await db
      .select({ last: recurringMovements.lastMaterializedMonth })
      .from(recurringMovements)
      .where(eq(recurringMovements.id, recurring.id));
    expect(pointer.last).toBe("2026-08-01"); // advanced anyway
  });
});
