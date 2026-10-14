import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { budgets, categories, loanPayments, loans, transactions, users } from "@/db/schema";
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
      // Payment-method partition of spentCents (both cash in this fixture).
      spentCashCents: 19134,
      spentCardCents: 0,
      pct: 12.75,
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
  // Transporte-fixture tests (execution basis + payment split). They use the
  // Transporte category in Jan–Jul 2026 — months/categories the earlier
  // tests never touch — and clean up after themselves so the shared DB
  // stays unpolluted.
  // ---------------------------------------------------------------------------

  /** Wipes Transporte's Jan–Jul 2026 trace: budgets cleared, movements gone.
   * Runs at the START of each Transporte-fixture test too, so a failed
   * sibling test can never cascade its leftovers into the next assertion. */
  async function cleanupCarryFixture(): Promise<void> {
    await db
      .delete(transactions)
      .where(
        and(eq(transactions.categoryId, transporteId), lt(transactions.date, "2026-08-01")),
      );
    // Card-payment ledger rows RESTRICT the loan delete (their mirror
    // transactions cascade here) — a failed sibling that left rows behind
    // must not break this cleanup.
    await db.delete(loanPayments).where(
      inArray(
        loanPayments.loanId,
        db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Visa carry")),
      ),
    );
    await db.delete(loans).where(eq(loans.name, "Visa carry"));
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
      await setForMonth(appDb, admin, month, []);
    }
  }

  it("card purchases count in their month's execution and totals", async () => {
    await cleanupCarryFixture();
    await setForMonth(appDb, admin, "2026-02", [{ categoryId: transporteId, amount: "1.000,00" }]);
    await db.insert(transactions).values({
      date: "2026-02-10",
      amountCents: 40_000,
      type: "expense",
      categoryId: transporteId,
      memberId,
    });

    // Budget execution includes card purchases: 250 card + 400 cash in
    // February's category spend AND totals.
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
    const february = await getMonth(appDb, "2026-02");
    expect(february?.rows.find((item) => item.categoryId === transporteId)?.spentCents).toBe(
      65_000, // 40.000 cash + 25.000 card
    );
    expect(february?.totals.spentCents).toBe(65_000);
    // Payment-method partition of February's execution: 40.000 cash +
    // 25.000 card, summing to spentCents.
    expect(february?.totals.spentCashCents).toBe(40_000);
    expect(february?.totals.spentCardCents).toBe(25_000);

    await cleanupCarryFixture();
  });

  it("card payments fill the Pago de tarjetas row; that row counts in the totals", async () => {
    await cleanupCarryFixture();
    const [pagoTarjetas, interesTarjetas, cuotaManejo, pagoPrestamos] = await db
      .insert(categories)
      .values([
        { name: "Pago de tarjetas", kind: "expense", color: "#ef4444" },
        { name: "Intereses de tarjetas", kind: "expense", color: "#f59e0b" },
        { name: "Cuota de manejo de tarjetas", kind: "expense", color: "#f59e0b" },
        { name: "Pago de préstamos", kind: "expense", color: "#64748b" },
      ])
      .returning();

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

    // May: a card purchase (the real category spend) plus the card's
    // payment — capital 450 (fills the settlement row against its plan),
    // interest 50 and fee 30 (new money out) — and an unrelated loan
    // payment 200 (counts: real cash outflow).
    // Transporte (not Super) so cleanupCarryFixture's date-bounded delete
    // also covers this purchase — a mid-test failure can never leave the
    // card referencing a purchase the next cleanup's loan delete hits.
    const [purchase] = await db
      .insert(transactions)
      .values({
        date: "2026-05-02",
        amountCents: 40_000,
        type: "expense",
        categoryId: transporteId,
        memberId,
        paymentMethod: "card",
        cardLoanId: card.id,
      })
      .returning({ id: transactions.id });
    const ledgerRows = await db
      .insert(loanPayments)
      .values([
        { loanId: card.id, memberId, kind: "payment", amountCents: 45_000, date: "2026-05-20" },
        {
          loanId: card.id,
          memberId: null,
          kind: "interest",
          amountCents: 5_000,
          date: "2026-05-20",
          note: "Interés de ciclo",
        },
        {
          loanId: card.id,
          memberId: null,
          kind: "charge",
          amountCents: 3_000,
          date: "2026-05-20",
          note: "Cuota de manejo",
        },
        { loanId: card.id, memberId, kind: "payment", amountCents: 20_000, date: "2026-05-21" },
      ])
      .returning({ id: loanPayments.id });
    const [capitalPayment, interest, fee, loanPayment] = ledgerRows;
    await db.insert(transactions).values([
      {
        date: "2026-05-20",
        amountCents: 45_000,
        type: "expense",
        categoryId: pagoTarjetas.id,
        memberId,
        loanPaymentId: capitalPayment.id,
      },
      {
        date: "2026-05-20",
        amountCents: 5_000,
        type: "expense",
        categoryId: interesTarjetas.id,
        memberId,
        loanPaymentId: interest.id,
      },
      {
        date: "2026-05-20",
        amountCents: 3_000,
        type: "expense",
        categoryId: cuotaManejo.id,
        memberId,
        loanPaymentId: fee.id,
      },
      {
        date: "2026-05-21",
        amountCents: 20_000,
        type: "expense",
        categoryId: pagoPrestamos.id,
        memberId,
        loanPaymentId: loanPayment.id,
      },
    ]);

    // The settlement row gets its own plan; the other mirror categories are
    // planned too so the totals are observable.
    await setForMonth(appDb, admin, "2026-05", [
      { categoryId: pagoTarjetas.id, amount: "500,00" },
      { categoryId: interesTarjetas.id, amount: "50,00" },
      { categoryId: cuotaManejo.id, amount: "30,00" },
      { categoryId: pagoPrestamos.id, amount: "200,00" },
    ]);

    const view = await getMonth(appDb, "2026-05");
    expect(view).not.toBeNull();
    if (!view) return;
    const rows = new Map(view.rows.map((row) => [row.categoryName, row]));
    // The purchase counts in its real category.
    expect(rows.get("Transporte")?.spentCents).toBe(40_000);
    // The payment FILLS its own row: the capital mirrors count against
    // the settlement plan (90% → warn), and the row reaches the totals.
    expect(rows.get("Pago de tarjetas")).toMatchObject({
      plannedCents: 50_000,
      spentCents: 45_000,
      pct: 90,
      remainingCents: 5_000,
      status: "warn",
    });
    // Finance costs and loan payments are real new money out — they count.
    expect(rows.get("Intereses de tarjetas")?.spentCents).toBe(5_000);
    expect(rows.get("Cuota de manejo de tarjetas")?.spentCents).toBe(3_000);
    expect(rows.get("Pago de préstamos")?.spentCents).toBe(20_000);
    // The settlement row counts in the totals like any other category
    // (user-accepted consequence: the same money counts twice — purchase
    // in its category + payment here).
    expect(view.totals).toMatchObject({
      plannedCents: 78_000, // 500 + 500 + 50 + 30 + 200
      spentCents: 113_000, // 400 + 450 + 50 + 30 + 200
    });
    // Payment-method partition of the execution: cash side carries every
    // mirror (settlement 450 + interest 50 + fee 30 + loan payment 200 —
    // real cash out), card side only the purchase. Sum = spentCents.
    expect(view.totals.spentCashCents).toBe(73_000);
    expect(view.totals.spentCardCents).toBe(40_000);
    expect(view.totals.spentCashCents + view.totals.spentCardCents).toBe(
      view.totals.spentCents,
    );

    // Cleanup: purchase first (cardLoanId RESTRICT), then the ledger rows
    // (their mirrors cascade via loanPaymentId; loanId itself is RESTRICT),
    // then the loan, every fixture-category transaction (they RESTRICT the
    // category delete) and the fixture categories.
    await db.delete(transactions).where(eq(transactions.id, purchase.id));
    await db.delete(loanPayments).where(eq(loanPayments.loanId, card.id));
    await db.delete(loans).where(eq(loans.id, card.id));
    await db.delete(transactions).where(
      inArray(transactions.categoryId, [
        pagoTarjetas.id,
        interesTarjetas.id,
        cuotaManejo.id,
        pagoPrestamos.id,
      ]),
    );
    // The May plan references the fixture categories (budgets RESTRICT
    // the delete) — clear the month first.
    await setForMonth(appDb, admin, "2026-05", []);
    await db.delete(categories).where(
      inArray(categories.id, [pagoTarjetas.id, interesTarjetas.id, cuotaManejo.id, pagoPrestamos.id]),
    );
    await cleanupCarryFixture();
  });
});
