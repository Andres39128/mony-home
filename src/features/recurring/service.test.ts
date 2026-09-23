import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, recurringMovements, transactions, users } from "@/db/schema";
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
 * Recurring CRUD suite (PGlite): admin-only mutations, category kind / member
 * status rules, and the shared amount parser with movements-style ambiguity
 * discrimination ('1.234' → guided ambiguous_amount, not a generic rejection).
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
});
