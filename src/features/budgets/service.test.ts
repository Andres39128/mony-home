import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { budgets, categories, loans, transactions, users } from "@/db/schema";
import {
  copyFromPreviousMonth,
  getMonth,
  previousMonth,
  setForMonth,
  type BudgetEntryInput,
} from "@/features/budgets/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Budgets service suite: replace-all month semantics, typed business-rule
 * errors (kind/inactive/auth/format/amount), exact-cent spent aggregation
 * with inclusive month bounds, and copy-from-previous-month — against
 * in-memory Postgres with the real migrations.
 */
describe("budgets service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;
  let superId: string;
  let sueldoId: string;
  let inactivaId: string;
  let ocioId: string;
  let transporteId: string;

  /** Fixture: two expenses for Super inside 2026-09, one outside, one income. */
  async function seedSeptemberMovements(): Promise<void> {
    await db.insert(transactions).values([
      { date: "2026-09-05", amountCents: 12345, type: "expense", categoryId: superId, memberId },
      // Last calendar day of the month must be included (inclusive bounds).
      { date: "2026-09-30", amountCents: 6789, type: "expense", categoryId: superId, memberId },
      { date: "2026-10-01", amountCents: 999999, type: "expense", categoryId: superId, memberId },
      { date: "2026-09-10", amountCents: 1000000, type: "income", categoryId: sueldoId, memberId },
    ]);
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [adminRow] = await db
      .insert(users)
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    const [mateRow] = await db
      .insert(users)
      .values({ username: "mate", name: "Mate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: adminRow.role };
    member = { id: mateRow.id, username: mateRow.username, name: mateRow.name, role: mateRow.role };
    memberId = mateRow.id;

    const inserted = await db
      .insert(categories)
      .values([
        { name: "Super", kind: "expense", color: "#22c55e" },
        { name: "Transporte", kind: "expense", color: "#3b82f6" },
        { name: "Ocio", kind: "expense", color: "#a855f7" },
        { name: "Sueldo", kind: "income", color: "#eab308" },
        { name: "Vieja", kind: "expense", color: "#78716c", isActive: false },
      ])
      .returning();
    const byName = new Map(inserted.map((row) => [row.name, row.id]));
    superId = byName.get("Super")!;
    ocioId = byName.get("Ocio")!;
    sueldoId = byName.get("Sueldo")!;
    inactivaId = byName.get("Vieja")!;
    transporteId = byName.get("Transporte")!;
  });

  afterAll(async () => {
    await client.close();
  });

  it("roundtrips set + get with exact cents, totals and reused context totals", async () => {
    await seedSeptemberMovements();
    const entries: BudgetEntryInput[] = [
      { categoryId: superId, amount: "1.000,00" },
      { categoryId: ocioId, amount: "500,50" },
    ];
    expect(await setForMonth(appDb, admin, "2026-09", entries)).toEqual({ ok: true });

    const view = await getMonth(appDb, "2026-09");
    expect(view).not.toBeNull();
    if (!view) return;

    const rows = new Map(view.rows.map((row) => [row.categoryName, row]));
    // Budgeted category: planned 100000, spent 12345 + 6789 = 19134 exact cents.
    expect(rows.get("Super")).toMatchObject({
      categoryId: superId,
      color: "#22c55e",
      plannedCents: 100000,
      spentCents: 19134,
      pct: 19.13,
      remainingCents: 80866,
      status: "ok",
    });
    // Budgeted with decimals: 500,50 → 50050 cents.
    expect(rows.get("Ocio")).toMatchObject({ plannedCents: 50050, spentCents: 0 });
    // Unbudgeted active expense category still appears, with zeros.
    expect(rows.get("Transporte")).toMatchObject({
      plannedCents: 0,
      spentCents: 0,
      remainingCents: 0,
      status: "ok",
    });
    // Income-kind and inactive categories are NOT rows.
    expect(rows.has("Sueldo")).toBe(false);
    expect(rows.has("Vieja")).toBe(false);

    expect(view.totals).toEqual({
      plannedCents: 150050,
      spentCents: 19134,
      pct: 12.75,
      carryCents: 0,
      availableCents: 150050,
    });
    // Context comes from transactions.totals (income ignored for expense sums).
    expect(view.context).toEqual({ incomeCents: 1000000, expenseCents: 19134 });
  });

  it("rejects income-kind and inactive categories with typed errors", async () => {
    expect(
      await setForMonth(appDb, admin, "2026-09", [{ categoryId: sueldoId, amount: "100" }]),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
    expect(
      await setForMonth(appDb, admin, "2026-09", [{ categoryId: inactivaId, amount: "100" }]),
    ).toEqual({ ok: false, error: "category_inactive" });
  });

  it("rejects members, malformed months and unparseable/negative amounts", async () => {
    expect(
      await setForMonth(appDb, member, "2026-09", [{ categoryId: superId, amount: "1" }]),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await setForMonth(appDb, admin, "2026-9", [{ categoryId: superId, amount: "1" }]),
    ).toEqual({ ok: false, error: "invalid_month" });
    expect(
      await setForMonth(appDb, admin, "septiembre", [{ categoryId: superId, amount: "1" }]),
    ).toEqual({ ok: false, error: "invalid_month" });
    expect(
      await setForMonth(appDb, admin, "2026-09", [{ categoryId: superId, amount: "no-vale" }]),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(
      await setForMonth(appDb, admin, "2026-09", [{ categoryId: superId, amount: "-100" }]),
    ).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("replaces the whole month on a second set (old rows fully gone)", async () => {
    expect(
      await setForMonth(appDb, admin, "2026-09", [{ categoryId: superId, amount: "2.000,00" }]),
    ).toEqual({ ok: true });

    const view = await getMonth(appDb, "2026-09");
    expect(view).not.toBeNull();
    if (!view) return;
    const rows = new Map(view.rows.map((row) => [row.categoryName, row]));
    expect(rows.get("Super")).toMatchObject({ plannedCents: 200000 });
    // Ocio's previous budget was wiped by the replace-all.
    expect(rows.get("Ocio")).toMatchObject({ plannedCents: 0 });
    expect(view.totals.plannedCents).toBe(200000);
  });

  it("clears the month with empty entries", async () => {
    expect(await setForMonth(appDb, admin, "2026-09", [])).toEqual({ ok: true });
    const remaining = await db.select().from(budgets).where(eq(budgets.month, "2026-09-01"));
    expect(remaining).toHaveLength(0);
  });

  it("copies budgets from the previous month and reports nothing_to_copy when empty", async () => {
    expect(
      await setForMonth(appDb, admin, "2026-08", [
        { categoryId: superId, amount: "1.500,00" },
        { categoryId: ocioId, amount: "250" },
      ]),
    ).toEqual({ ok: true });
    expect(await copyFromPreviousMonth(appDb, admin, "2026-09")).toEqual({ ok: true });

    const view = await getMonth(appDb, "2026-09");
    expect(view).not.toBeNull();
    if (!view) return;
    const rows = new Map(view.rows.map((row) => [row.categoryName, row]));
    expect(rows.get("Super")).toMatchObject({ plannedCents: 150000 });
    expect(rows.get("Ocio")).toMatchObject({ plannedCents: 25000 });

    // A month with no previous budgets reports the typed error.
    expect(await copyFromPreviousMonth(appDb, admin, "2027-01")).toEqual({
      ok: false,
      error: "nothing_to_copy",
    });
    expect(await copyFromPreviousMonth(appDb, member, "2026-09")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await copyFromPreviousMonth(appDb, admin, "mal")).toEqual({
      ok: false,
      error: "invalid_month",
    });
  });

  it("returns null for a malformed month on read", async () => {
    expect(await getMonth(appDb, "2026-13")).toBeNull();
  });

  it("exposes overCount: categories whose spend exceeded their plan", async () => {
    // A month with no overs counts zero.
    const untouched = await getMonth(appDb, "2026-12");
    expect(untouched?.overCount).toBe(0);

    await db.insert(transactions).values({
      date: "2026-11-05",
      amountCents: 50_000,
      type: "expense",
      categoryId: superId,
      memberId,
    });
    await setForMonth(appDb, admin, "2026-11", [
      { categoryId: superId, amount: "100" }, // spent 50.000 > 100 → over
      { categoryId: ocioId, amount: "100.000,00" }, // spent 0 → ok
    ]);
    const view = await getMonth(appDb, "2026-11");
    expect(view?.overCount).toBe(1);
  });

  it("computes the previous month across the year boundary", () => {
    expect(previousMonth("2026-09")).toBe("2026-08");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });

  // ---------------------------------------------------------------------------
  // Rollover (F2): net carry per category. These use the Transporte category
  // in Jan–Jul 2026 — months/categories the earlier tests never touch — and
  // clean up after themselves so the shared DB stays unpolluted.
  // ---------------------------------------------------------------------------

  /** Wipes Transporte's Jan–Jul 2026 trace: budgets cleared, movements gone.
   * Runs at the START of each carry test too, so a failed sibling test can
   * never cascade its leftovers into the next assertion. */
  async function cleanupCarryFixture(): Promise<void> {
    await db
      .delete(transactions)
      .where(
        and(eq(transactions.categoryId, transporteId), lt(transactions.date, "2026-08-01")),
      );
    await db.delete(loans).where(eq(loans.name, "Visa carry"));
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
      await setForMonth(appDb, admin, month, []);
    }
  }

  it("carry: zero on the first month — disponible equals the plan", async () => {
    await cleanupCarryFixture();
    await setForMonth(appDb, admin, "2026-01", [{ categoryId: transporteId, amount: "1.000,00" }]);
    const view = await getMonth(appDb, "2026-01");
    expect(view).not.toBeNull();
    if (!view) return;
    const row = view.rows.find((item) => item.categoryId === transporteId)!;
    expect(row.carryCents).toBe(0);
    expect(row.availableCents).toBe(100_000);
    expect(view.totals.carryCents).toBe(0);
    expect(view.totals.availableCents).toBe(view.totals.plannedCents);
    await cleanupCarryFixture();
  });

  it("carry: positive after under-spend; card purchases never drag", async () => {
    await cleanupCarryFixture();
    await setForMonth(appDb, admin, "2026-02", [{ categoryId: transporteId, amount: "1.000,00" }]);
    await db.insert(transactions).values({
      date: "2026-02-10",
      amountCents: 40_000,
      type: "expense",
      categoryId: transporteId,
      memberId,
    });
    await setForMonth(appDb, admin, "2026-04", [{ categoryId: transporteId, amount: "500,00" }]);

    const view = await getMonth(appDb, "2026-04");
    expect(view).not.toBeNull();
    if (!view) return;
    const row = view.rows.find((item) => item.categoryId === transporteId)!;
    expect(row.carryCents).toBe(60_000); // 1.000 − 400
    expect(row.availableCents).toBe(110_000); // 500 + 600
    expect(view.totals.availableCents).toBe(
      view.totals.plannedCents + view.totals.carryCents,
    );

    // A card purchase is DEBT, not budget execution: it must not drag.
    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa carry",
        kind: "credit_card",
        entity: "Banco",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents: 1_000_000,
      })
      .returning();
    await db.insert(transactions).values({
      date: "2026-02-11",
      amountCents: 25_000,
      type: "expense",
      categoryId: transporteId,
      memberId,
      paymentMethod: "card",
      cardLoanId: card.id,
    });
    const afterCard = await getMonth(appDb, "2026-04");
    expect(
      afterCard?.rows.find((item) => item.categoryId === transporteId)?.carryCents,
    ).toBe(60_000);

    await cleanupCarryFixture();
  });

  it("carry: negative after over-spend", async () => {
    await cleanupCarryFixture();
    await setForMonth(appDb, admin, "2026-02", [{ categoryId: transporteId, amount: "1.000,00" }]);
    await db.insert(transactions).values({
      date: "2026-02-10",
      amountCents: 200_000,
      type: "expense",
      categoryId: transporteId,
      memberId,
    });
    await setForMonth(appDb, admin, "2026-04", [{ categoryId: transporteId, amount: "500,00" }]);

    const view = await getMonth(appDb, "2026-04");
    expect(view).not.toBeNull();
    if (!view) return;
    const row = view.rows.find((item) => item.categoryId === transporteId)!;
    expect(row.carryCents).toBe(-100_000); // 1.000 − 2.000
    expect(row.availableCents).toBe(-50_000); // 500 − 1.000
    await cleanupCarryFixture();
  });

  it("carry: skips future months entirely", async () => {
    await cleanupCarryFixture();
    // June's budget and spend are STRICTLY AFTER April — they must not
    // leak into April's carry.
    await setForMonth(appDb, admin, "2026-06", [{ categoryId: transporteId, amount: "9.000,00" }]);
    await db.insert(transactions).values({
      date: "2026-06-10",
      amountCents: 30_000,
      type: "expense",
      categoryId: transporteId,
      memberId,
    });

    const view = await getMonth(appDb, "2026-04");
    expect(view).not.toBeNull();
    if (!view) return;
    const row = view.rows.find((item) => item.categoryId === transporteId)!;
    expect(row.carryCents).toBe(0);
    expect(row.availableCents).toBe(0); // no April budget either
    await cleanupCarryFixture();
  });

  it("carry: unbudgeted prior months contribute their spend (net rule, plan defaults 0)", async () => {
    await cleanupCarryFixture();
    await setForMonth(appDb, admin, "2026-02", [{ categoryId: transporteId, amount: "1.000,00" }]);
    await db.insert(transactions).values([
      // Budgeted February: 1.000 − 400 = +600.
      { date: "2026-02-10", amountCents: 40_000, type: "expense", categoryId: transporteId, memberId },
      // UNBUDGETED March: plan 0 − 800 = −800. The spend still debits.
      { date: "2026-03-10", amountCents: 80_000, type: "expense", categoryId: transporteId, memberId },
    ]);
    await setForMonth(appDb, admin, "2026-04", [{ categoryId: transporteId, amount: "500,00" }]);

    const view = await getMonth(appDb, "2026-04");
    expect(view).not.toBeNull();
    if (!view) return;
    const row = view.rows.find((item) => item.categoryId === transporteId)!;
    expect(row.carryCents).toBe(-20_000); // 600 − 800
    expect(row.availableCents).toBe(30_000); // 500,00 plan + (−200,00) carry
    await cleanupCarryFixture();
  });
});
