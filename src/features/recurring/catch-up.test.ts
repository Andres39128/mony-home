import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { recurringMovements, transactions, users, categories } from "@/db/schema";
import { catchUpRecurringMovements } from "@/features/recurring/catch-up";
import { removeRecurring } from "@/features/recurring/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Lazy monthly materialization suite (PGlite, injectable `now`):
 * - one transaction per elapsed month, dated dayOfMonth,
 * - the CREATION MONTH never materializes (first materialization = the month
 *   after creation — savings' "creation day doesn't accrue" precedent),
 * - the current month waits for its dayOfMonth (no future-dated rows),
 * - dayOfMonth caps at 28 because February is the shortest month: every
 *   month is guaranteed to have day 28, so no date clamping is ever needed
 *   (a 31-style day would need per-month clamping — the CHECK forbids it).
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
});
