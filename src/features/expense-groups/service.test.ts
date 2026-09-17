import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, expenseGroups, transactions, users } from "@/db/schema";
import {
  expenseGroupSchema,
  createExpenseGroup,
  listExpenseGroups,
  removeExpenseGroup,
  setExpenseGroupStatus,
  updateExpenseGroup,
  type ExpenseGroupInput,
} from "@/features/expense-groups/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Expense groups service suite: CRUD, active/closed flow, transaction count
 * aggregation and SET-NULL deletion (movements survive groupless), with
 * service-level authorization — against in-memory Postgres with the real
 * migrations.
 */
describe("expense groups service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;
  let categoryId: string;

  const validInput: ExpenseGroupInput = { name: "Viaje Bariloche", description: "" };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    const [mate] = await db
      .insert(users)
      .values({ username: "mate", name: "Mate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    member = { id: mate.id, username: mate.username, name: mate.name, role: mate.role };
    memberId = mate.id;
    const [category] = await db
      .insert(categories)
      .values({ name: "Grupo Cat", kind: "expense" })
      .returning();
    categoryId = category.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a group with an empty description normalized to null", async () => {
    expect(await createExpenseGroup(appDb, validInput)).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(expenseGroups)
      .where(eq(expenseGroups.name, "Viaje Bariloche"));
    expect(row).toMatchObject({ status: "active", description: null });
  });

  it("updates name and description (admin)", async () => {
    await createExpenseGroup(appDb, { name: "Editable", description: "" });
    const [row] = await db.select().from(expenseGroups).where(eq(expenseGroups.name, "Editable"));

    const result = await updateExpenseGroup(appDb, admin, row.id, {
      name: "Editado",
      description: "Salida de fin de semana",
    });

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(expenseGroups).where(eq(expenseGroups.id, row.id));
    expect(after).toMatchObject({ name: "Editado", description: "Salida de fin de semana" });
  });

  it("closes and reopens a group (admin)", async () => {
    await createExpenseGroup(appDb, { name: "Cerrable", description: "" });
    const [row] = await db.select().from(expenseGroups).where(eq(expenseGroups.name, "Cerrable"));

    expect(await setExpenseGroupStatus(appDb, admin, row.id, "closed")).toEqual({ ok: true });
    let after = await db.select().from(expenseGroups).where(eq(expenseGroups.id, row.id));
    expect(after[0].status).toBe("closed");

    expect(await setExpenseGroupStatus(appDb, admin, row.id, "active")).toEqual({ ok: true });
    after = await db.select().from(expenseGroups).where(eq(expenseGroups.id, row.id));
    expect(after[0].status).toBe("active");
  });

  it("lists groups with their transaction count", async () => {
    const [group] = await db
      .insert(expenseGroups)
      .values({ name: "Con Movimientos" })
      .returning();
    await db.insert(expenseGroups).values({ name: "Sin Movimientos" });
    await db.insert(transactions).values([
      {
        amountCents: 100,
        type: "expense",
        categoryId,
        memberId,
        groupId: group.id,
      },
      {
        amountCents: 200,
        type: "expense",
        categoryId,
        memberId,
        groupId: group.id,
      },
    ]);

    const listed = await listExpenseGroups(appDb);
    const withCount = listed.find((g) => g.name === "Con Movimientos");
    const withoutCount = listed.find((g) => g.name === "Sin Movimientos");
    expect(withCount?.transactionCount).toBe(2);
    expect(withoutCount?.transactionCount).toBe(0);
  });

  it("deleting a group sets transactions.group_id to null; movements survive", async () => {
    const [group] = await db.insert(expenseGroups).values({ name: "Eliminable" }).returning();
    const [tx] = await db
      .insert(transactions)
      .values({ amountCents: 300, type: "expense", categoryId, memberId, groupId: group.id })
      .returning();

    const result = await removeExpenseGroup(appDb, admin, group.id);

    expect(result).toEqual({ ok: true });
    const [survivor] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(survivor.groupId).toBeNull();
  });

  it("reports a typed error for unknown ids", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(
      await updateExpenseGroup(appDb, admin, ghostId, validInput),
    ).toEqual({ ok: false, error: "group_not_found" });
    expect(await setExpenseGroupStatus(appDb, admin, ghostId, "closed")).toEqual({
      ok: false,
      error: "group_not_found",
    });
    expect(await removeExpenseGroup(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "group_not_found",
    });
  });

  it("enforces authorization at service level (member can create, not administer)", async () => {
    expect(await createExpenseGroup(appDb, validInput)).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(expenseGroups)
      .where(eq(expenseGroups.name, validInput.name));

    expect(await updateExpenseGroup(appDb, member, row.id, validInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await setExpenseGroupStatus(appDb, member, row.id, "closed")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await removeExpenseGroup(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("input schema rejects empty names and overlong descriptions", () => {
    expect(expenseGroupSchema.safeParse({ name: "", description: "" }).success).toBe(false);
    expect(expenseGroupSchema.safeParse({ name: "X", description: "x".repeat(281) }).success).toBe(
      false,
    );
    expect(expenseGroupSchema.safeParse({ name: "  Viaje  ", description: "" }).success).toBe(true);
  });
});
