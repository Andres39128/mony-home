import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, loans, savingsGoals, transactions, users } from "@/db/schema";
import {
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MOVEMENTS_LIMIT,
  globalSearch,
  normalizeQuery,
} from "@/features/search/service";

let db: PgliteDatabase;
let appDb: Database;
let client: PGlite;

/** Minimal completed cash expense attributed to a member. */
function expense(values: Partial<typeof transactions.$inferInsert>) {
  return db.insert(transactions).values({
    memberId: memberId,
    categoryId: categoryId,
    amountCents: 10_000,
    type: "expense",
    scope: "common",
    paymentMethod: "cash",
    ...values,
  });
}

let memberId = "";
let categoryId = "";

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  appDb = db as unknown as Database;

  const [member] = await db
    .insert(users)
    .values({ username: "andres", name: "Andrés", passwordHash: "x" })
    .returning();
  memberId = member.id;

  const [market] = await db
    .insert(categories)
    .values({ name: "Mercado", kind: "expense", color: "#a8dadc" })
    .returning();
  categoryId = market.id;

  await expense({ note: "Supermercado semanal", date: "2026-09-01" });
  await expense({ note: "Alquiler septiembre", date: "2026-09-02" });
  // Wildcard carriers: % and _ must match as literals, never as wildcards.
  await expense({ note: "Gané el 100% del bono", date: "2026-09-03" });
  await expense({ note: "Súper mercado", date: "2026-09-04" });
  // Newest row first: ordering sanity for the same query.
  await expense({ note: "Supermercado del domingo", date: "2026-09-05" });

  // Pending quick-capture placeholder: never a search hit.
  await db.insert(transactions).values({
    memberId,
    amountCents: 0,
    type: "expense",
    scope: "common",
    needsDetails: true,
    note: "Pendiente incluir detalles.",
  });

  await db.insert(savingsGoals).values([
    { name: "Vacaciones 2027", kind: "savings", scope: "common" },
    { name: "Fondo de emergencia", kind: "savings", scope: "common" },
  ]);

  await db.insert(loans).values([
    {
      name: "Visa oro",
      kind: "credit_card",
      entity: "Davivienda",
      scope: "common",
      principalCents: 0,
      amortizationMode: "revolving",
      creditLimitCents: 5_000_000,
      statementDay: 5,
    },
    {
      name: "Libre inversión",
      kind: "investment_line",
      entity: "Banco Bogotá",
      scope: "common",
      principalCents: 3_000_000,
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("normalizeQuery", () => {
  it("trims and clamps the query", () => {
    expect(normalizeQuery("  super  ")).toBe("super");
    expect(normalizeQuery("x".repeat(500)).length).toBe(SEARCH_MAX_QUERY_LENGTH);
  });
});

describe("globalSearch (integration on PGlite)", () => {
  it("returns the empty object (never an error) under the minimum length", async () => {
    expect(await globalSearch(appDb, "")).toEqual({ movements: [], bolsas: [], prestamos: [] });
    expect(await globalSearch(appDb, " ")).toEqual({ movements: [], bolsas: [], prestamos: [] });
    expect(await globalSearch(appDb, "s")).toEqual({ movements: [], bolsas: [], prestamos: [] });
  });

  it("matches movements by note, newest first", async () => {
    const { movements } = await globalSearch(appDb, "supermercado");
    expect(movements.map((m) => m.date)).toEqual(["2026-09-05", "2026-09-01"]);
    expect(movements[0]).toMatchObject({
      type: "expense",
      amountCents: 10_000,
      categoryName: "Mercado",
      memberName: "Andrés",
    });
  });

  it("matches movements by category name and by member name", async () => {
    const byCategory = await globalSearch(appDb, "mercado");
    // Category "Mercado" matches every seeded expense; notes carrying
    // "mercado" hit the same rows — the OR keeps one row per movement.
    expect(byCategory.movements).toHaveLength(5);

    const byMember = await globalSearch(appDb, "Andrés");
    // Every completed movement names the only member; pending rows don't match.
    expect(byMember.movements).toHaveLength(5);
  });

  it("escapes % and _ as literals", async () => {
    // % literal: only the bono note carries "100%".
    const percent = await globalSearch(appDb, "100%");
    expect(percent.movements).toHaveLength(1);
    // Unescaped, "%100" would match any note containing "100" — escaped it
    // matches nothing (no note starts with a literal %).
    const leading = await globalSearch(appDb, "%100");
    expect(leading.movements).toHaveLength(0);

    // _ literal: unescaped, "súper_m" would match "Súper mercado" (any char).
    const underscore = await globalSearch(appDb, "súper_m");
    expect(underscore.movements).toHaveLength(0);
    expect((await globalSearch(appDb, "súper m")).movements).toHaveLength(1);
  });

  it("excludes pending quick-capture rows", async () => {
    const { movements } = await globalSearch(appDb, "Pendiente");
    expect(movements).toHaveLength(0);
  });

  it("matches goals by name with kind and netCents", async () => {
    const { bolsas } = await globalSearch(appDb, "FONDO"); // case-insensitive
    expect(bolsas).toHaveLength(1);
    expect(bolsas[0]).toMatchObject({ name: "Fondo de emergencia", kind: "savings", netCents: 0 });
  });

  it("matches loans by name OR entity with kind and outstanding", async () => {
    const byEntity = await globalSearch(appDb, "davi");
    expect(byEntity.prestamos).toHaveLength(1);
    expect(byEntity.prestamos[0]).toMatchObject({
      name: "Visa oro",
      entity: "Davivienda",
      kind: "credit_card",
      amortizationMode: "revolving",
    });

    const byName = await globalSearch(appDb, "libre inversión");
    expect(byName.prestamos).toHaveLength(1);
    expect(byName.prestamos[0]?.name).toBe("Libre inversión");
    expect(byName.prestamos[0]?.outstandingCents).toBe(3_000_000);
  });

  it("applies the per-group limits", async () => {
    for (let i = 0; i < SEARCH_MOVEMENTS_LIMIT + 1; i++) {
      await expense({ note: `limite movimiento ${i}`, date: "2026-08-15" });
    }
    for (let i = 0; i < 11; i++) {
      await db
        .insert(savingsGoals)
        .values({ name: `limite meta ${i}`, kind: "savings", scope: "common" });
    }
    for (let i = 0; i < 11; i++) {
      await db.insert(loans).values({
        name: `limite préstamo ${i}`,
        kind: "other",
        entity: `Entidad ${i}`,
        scope: "common",
        principalCents: 100_000,
      });
    }

    const { movements, bolsas, prestamos } = await globalSearch(appDb, "limite");
    expect(movements).toHaveLength(SEARCH_MOVEMENTS_LIMIT);
    expect(bolsas).toHaveLength(10);
    expect(prestamos).toHaveLength(10);
  });
});
