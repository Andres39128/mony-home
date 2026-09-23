import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { budgets, categories, expenseGroups, transactions, users } from "@/db/schema";
import {
  DEFAULT_MONTHS_BACK,
  cumulativeBudgetVsActual,
  expensesByCategory,
  monthlyTotals,
} from "@/features/analytics/service";

/**
 * Analytics suite: exact-cent groupings per chart, gap-month zero-fill,
 * filter honoring (member/scope/category/group) and cumulative
 * budget-vs-actual math (missing budget month carries 0) — against
 * in-memory Postgres with the real migrations.
 */
describe("analytics service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let mateId: string;
  let anaId: string;
  let sueldo: { id: string };
  let superCat: { id: string };
  let ocio: { id: string };
  let vacaciones: { id: string };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;

    const [, mateRow, anaRow] = await db
      .insert(users)
      .values([
        { username: "admin", name: "Admin", passwordHash: "x", role: "admin" },
        { username: "mate", name: "Mate", passwordHash: "x" },
        { username: "ana", name: "Ana", passwordHash: "x" },
      ])
      .returning();
    mateId = mateRow.id;
    anaId = anaRow.id;

    [sueldo, superCat, ocio] = await db
      .insert(categories)
      .values([
        { name: "Sueldo", kind: "income", color: "#0ea5e9" },
        { name: "Super", kind: "expense", color: "#16a34a" },
        { name: "Ocio", kind: "expense", color: "#f97316" },
      ])
      .returning();

    [vacaciones] = await db
      .insert(expenseGroups)
      .values([{ name: "Vacaciones", status: "active" }])
      .returning();

    await db.insert(transactions).values([
      // 2025-12: outside every window below.
      { date: "2025-12-20", amountCents: 12_345, type: "expense", categoryId: superCat.id, memberId: mateId, scope: "common" },
      // 2026-01.
      { date: "2026-01-05", amountCents: 10_000, type: "expense", categoryId: superCat.id, memberId: mateId, scope: "common" },
      { date: "2026-01-10", amountCents: 5_000, type: "expense", categoryId: ocio.id, memberId: anaId, scope: "individual" },
      { date: "2026-01-28", amountCents: 50_000, type: "income", categoryId: sueldo.id, memberId: mateId, scope: "common" },
      // 2026-02 intentionally empty (gap month).
      // 2026-03.
      { date: "2026-03-02", amountCents: 20_000, type: "expense", categoryId: superCat.id, memberId: mateId, scope: "common", groupId: vacaciones.id },
      { date: "2026-03-15", amountCents: 8_000, type: "expense", categoryId: ocio.id, memberId: anaId, scope: "common" },
      { date: "2026-03-30", amountCents: 60_000, type: "income", categoryId: sueldo.id, memberId: mateId, scope: "common" },
    ]);

    // Budgets: 2026-02 intentionally missing so the cumulative curve carries.
    await db.insert(budgets).values([
      { month: "2026-01-01", categoryId: superCat.id, amountCents: 10_000 },
      { month: "2026-03-01", categoryId: superCat.id, amountCents: 5_000 },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  describe("expensesByCategory", () => {
    it("groups expenses by category in exact cents, biggest first, pct on 2 decimals", async () => {
      const slices = await expensesByCategory(appDb, { month: "2026-01" });
      expect(slices).toEqual([
        { categoryId: superCat.id, name: "Super", color: "#16a34a", cents: 10_000, pct: 66.67 },
        { categoryId: ocio.id, name: "Ocio", color: "#f97316", cents: 5_000, pct: 33.33 },
      ]);
    });

    it("includes expenses only — income categories never appear", async () => {
      const slices = await expensesByCategory(appDb, { month: "2026-03" });
      expect(slices.map((slice) => slice.name)).toEqual(["Super", "Ocio"]);
    });

    it("honors member, scope, group and category filters", async () => {
      expect(
        (await expensesByCategory(appDb, { month: "2026-01", memberId: anaId })).map((s) => s.cents),
      ).toEqual([5_000]);
      // Ana's 2026-01 movement is individual → excluded by the common scope.
      expect(
        (await expensesByCategory(appDb, { month: "2026-01", scope: "common" })).map((s) => s.name),
      ).toEqual(["Super"]);
      expect(
        (await expensesByCategory(appDb, { month: "2026-03", groupId: vacaciones.id })).map((s) => s.cents),
      ).toEqual([20_000]);
      expect(
        (await expensesByCategory(appDb, { month: "2026-03", categoryId: superCat.id })).map((s) => s.cents),
      ).toEqual([20_000]);
    });

    it("returns [] when nothing matches instead of throwing", async () => {
      expect(await expensesByCategory(appDb, { month: "2030-01" })).toEqual([]);
    });
  });

  describe("monthlyTotals", () => {
    it("zero-fills gap months and returns exact cents oldest-first", async () => {
      const rows = await monthlyTotals(appDb, "2026-03");
      expect(rows).toHaveLength(DEFAULT_MONTHS_BACK);
      expect(rows[0].month).toBe("2025-04");
      expect(rows[rows.length - 1].month).toBe("2026-03");
      const byMonth = new Map(rows.map((row) => [row.month, row]));
      expect(byMonth.get("2026-01")).toEqual({ month: "2026-01", incomeCents: 50_000, expenseCents: 15_000 });
      expect(byMonth.get("2026-02")).toEqual({ month: "2026-02", incomeCents: 0, expenseCents: 0 });
      expect(byMonth.get("2026-03")).toEqual({ month: "2026-03", incomeCents: 60_000, expenseCents: 28_000 });
      expect(byMonth.get("2025-12")).toEqual({ month: "2025-12", incomeCents: 0, expenseCents: 12_345 });
      // A 12-month window starting 2025-04 must not leak earlier months.
      expect(byMonth.has("2025-03")).toBe(false);
    });

    it("respects a shorter window", async () => {
      const rows = await monthlyTotals(appDb, "2026-03", 3);
      expect(rows.map((row) => row.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    });

    it("honors non-month filters (the window wins over any incoming month)", async () => {
      const rows = await monthlyTotals(appDb, "2026-03", 3, { memberId: anaId, month: "2026-01" });
      expect(rows).toEqual([
        { month: "2026-01", incomeCents: 0, expenseCents: 5_000 },
        { month: "2026-02", incomeCents: 0, expenseCents: 0 },
        { month: "2026-03", incomeCents: 0, expenseCents: 8_000 },
      ]);
    });

    it("returns a zero-filled window on empty data, not an error", async () => {
      const rows = await monthlyTotals(appDb, "2030-06", 2);
      expect(rows).toEqual([
        { month: "2030-05", incomeCents: 0, expenseCents: 0 },
        { month: "2030-06", incomeCents: 0, expenseCents: 0 },
      ]);
      expect(await monthlyTotals(appDb, "bad-month")).toEqual([]);
    });
  });

  describe("cumulativeBudgetVsActual", () => {
    it("accumulates budgets and expenses; a missing budget month carries 0", async () => {
      const points = await cumulativeBudgetVsActual(appDb, 2026, { month: "2026-03" });
      expect(points).toEqual([
        { month: "2026-01", plannedCumCents: 10_000, actualCumCents: 15_000 },
        // No 2026-02 budget row: planned stays, actual stays (no expenses).
        { month: "2026-02", plannedCumCents: 10_000, actualCumCents: 15_000 },
        { month: "2026-03", plannedCumCents: 15_000, actualCumCents: 43_000 },
      ]);
    });

    it("stops at the filter month — no future-zero spam", async () => {
      const points = await cumulativeBudgetVsActual(appDb, 2026, { month: "2026-01" });
      expect(points).toHaveLength(1);
      expect(points[0]).toEqual({ month: "2026-01", plannedCumCents: 10_000, actualCumCents: 15_000 });
    });

    it("spans the whole year when the filter month is outside it", async () => {
      const points = await cumulativeBudgetVsActual(appDb, 2026, { month: "2027-05" });
      expect(points).toHaveLength(12);
      expect(points[0].month).toBe("2026-01");
      expect(points[11].month).toBe("2026-12");
    });

    it("honors category (also on the plan side) and scope filters", async () => {
      const onlySuper = await cumulativeBudgetVsActual(appDb, 2026, {
        month: "2026-03",
        categoryId: superCat.id,
      });
      expect(onlySuper[2]).toEqual({ month: "2026-03", plannedCumCents: 15_000, actualCumCents: 30_000 });

      const onlyCommon = await cumulativeBudgetVsActual(appDb, 2026, {
        month: "2026-01",
        scope: "common",
      });
      // Ana's individual 5.000 expense excluded.
      expect(onlyCommon[0]).toEqual({ month: "2026-01", plannedCumCents: 10_000, actualCumCents: 10_000 });
    });

    it("returns [] for a year with no data and for malformed years", async () => {
      expect(await cumulativeBudgetVsActual(appDb, 2030, { month: "2030-05" })).toEqual([]);
      expect(await cumulativeBudgetVsActual(appDb, Number.NaN)).toEqual([]);
      expect(await cumulativeBudgetVsActual(appDb, 20.5)).toEqual([]);
    });
  });
});
