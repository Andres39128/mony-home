import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, transactions, users } from "@/db/schema";
import {
  categorySchema,
  createCategory,
  listCategories,
  removeCategory,
  toggleCategoryActive,
  updateCategory,
  type CategoryInput,
} from "@/features/categories/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Categories service suite: CRUD, soft-delete toggle and the FK-protected
 * delete, with service-level authorization (create = any member, the rest
 * = admin only) against in-memory Postgres with the real migrations.
 */
describe("categories service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;

  const validInput: CategoryInput = {
    name: "Supermercado",
    kind: "expense",
    color: "#ef4444",
    icon: "",
  };

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
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a category with an empty icon normalized to null", async () => {
    const result = await createCategory(appDb, validInput);
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(categories).where(eq(categories.name, "Supermercado"));
    expect(row).toMatchObject({ kind: "expense", color: "#ef4444", icon: null, isActive: true });
  });

  it("rejects a duplicate name with a typed error (name is globally unique)", async () => {
    const second = await createCategory(appDb, validInput);
    expect(second).toEqual({ ok: false, error: "name_taken" });
  });

  it("lists ordered by kind, active first, then name", async () => {
    await createCategory(appDb, { ...validInput, name: "Sueldo", kind: "income", color: "#22c55e" });
    await createCategory(appDb, { ...validInput, name: "Ocio" });
    await db
      .insert(categories)
      .values({ name: "Veterinaria", kind: "expense", color: "#111111", isActive: false });

    const listed = await listCategories(appDb);
    // PG enums sort by declaration order: income before expense.
    expect(listed.map((c) => c.name)).toEqual([
      "Sueldo", // income group first (enum declaration order)
      "Ocio", // expense, active, a-z
      "Supermercado",
      "Veterinaria", // expense, inactive last
    ]);
  });

  it("updates name, color and icon (admin)", async () => {
    await createCategory(appDb, { ...validInput, name: "Editable" });
    const [row] = await db.select().from(categories).where(eq(categories.name, "Editable"));

    const result = await updateCategory(appDb, admin, row.id, {
      name: "Editada",
      kind: "expense",
      color: "#0ea5e9",
      icon: "🛒",
    });

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(categories).where(eq(categories.id, row.id));
    expect(after).toMatchObject({ name: "Editada", color: "#0ea5e9", icon: "🛒" });
  });

  it("reports a typed error when updating or toggling an unknown id", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await updateCategory(appDb, admin, ghostId, validInput)).toEqual({
      ok: false,
      error: "category_not_found",
    });
    expect(await toggleCategoryActive(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "category_not_found",
    });
    expect(await removeCategory(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "category_not_found",
    });
  });

  it("toggles active state as the delete alternative", async () => {
    await createCategory(appDb, { ...validInput, name: "Apagable" });
    const [row] = await db.select().from(categories).where(eq(categories.name, "Apagable"));

    expect(await toggleCategoryActive(appDb, admin, row.id)).toEqual({ ok: true });
    let after = await db.select().from(categories).where(eq(categories.id, row.id));
    expect(after[0].isActive).toBe(false);

    expect(await toggleCategoryActive(appDb, admin, row.id)).toEqual({ ok: true });
    after = await db.select().from(categories).where(eq(categories.id, row.id));
    expect(after[0].isActive).toBe(true);
  });

  it("deleting a category with movements fails with a typed restrict error", async () => {
    await createCategory(appDb, { ...validInput, name: "ConMovs" });
    const [row] = await db.select().from(categories).where(eq(categories.name, "ConMovs"));
    await db.insert(transactions).values({
      amountCents: 100,
      type: "expense",
      categoryId: row.id,
      memberId: member.id,
    });

    const result = await removeCategory(appDb, admin, row.id);

    expect(result).toEqual({ ok: false, error: "has_movements" });
    const stillThere = await db.select().from(categories).where(eq(categories.id, row.id));
    expect(stillThere).toHaveLength(1);
  });

  it("deleting a category without movements succeeds", async () => {
    await createCategory(appDb, { ...validInput, name: "Limpia" });
    const [row] = await db.select().from(categories).where(eq(categories.name, "Limpia"));

    expect(await removeCategory(appDb, admin, row.id)).toEqual({ ok: true });
    const gone = await db.select().from(categories).where(eq(categories.id, row.id));
    expect(gone).toHaveLength(0);
  });

  it("enforces authorization at service level (member can create, not administer)", async () => {
    const created = await createCategory(appDb, { ...validInput, name: "DeMiembro" });
    expect(created).toEqual({ ok: true });
    const [row] = await db.select().from(categories).where(eq(categories.name, "DeMiembro"));

    expect(await updateCategory(appDb, member, row.id, validInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await toggleCategoryActive(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await removeCategory(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  describe("input schema (trust boundary)", () => {
    it("accepts a 6-digit hex color and optional short icon", () => {
      const parsed = categorySchema.parse({
        name: "  Transporte  ",
        kind: "expense",
        color: "#AbCdEf",
        icon: " 🚌 ",
      });
      expect(parsed.name).toBe("Transporte");
      expect(parsed.color).toBe("#AbCdEf");
      expect(parsed.icon).toBe("🚌");
    });

    it("rejects bad colors, long icons, empty names and unknown kinds", () => {
      const base = { name: "X", kind: "expense" as const, color: "#123456", icon: "" };
      expect(categorySchema.safeParse({ ...base, color: "red" }).success).toBe(false);
      expect(categorySchema.safeParse({ ...base, color: "#12345" }).success).toBe(false);
      expect(categorySchema.safeParse({ ...base, icon: "un-icono-re-largo" }).success).toBe(false);
      expect(categorySchema.safeParse({ ...base, name: "" }).success).toBe(false);
      expect(categorySchema.safeParse({ ...base, kind: "other" }).success).toBe(false);
    });
  });
});
