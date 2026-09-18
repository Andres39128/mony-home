import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, loanPayments, loans, transactions, users } from "@/db/schema";
import {
  addLoanPayment,
  computeOutstanding,
  computePaidPct,
  createLoan,
  getDebtCents,
  loanPaymentSchema,
  loanSchema,
  listLoans,
  listPayments,
  outstandingSchema,
  removeLoan,
  toggleLoanActive,
  updateLoan,
  updateOutstanding,
  type LoanInput,
  type LoanPaymentInput,
} from "@/features/loans/service";
import { getPatrimony } from "@/features/savings/service";
import { todayIso, transactionTotals } from "@/features/transactions/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Loans service suite: loan CRUD + scope CHECK, outstanding math in exact
 * cents, member pinning, mirror transactions (R1), manual balance true-ups,
 * net patrimony and the full admin/member authorization matrix — against
 * in-memory Postgres with the real migrations.
 */

const cardInput: LoanInput = {
  name: "Visa Banco Nación",
  kind: "credit_card",
  entity: "Visa Banco Nación",
  scope: "common",
  memberId: "",
  principal: "850.000",
  annualRate: "",
};

const mortgageInput: LoanInput = {
  name: "Hipoteca casa",
  kind: "mortgage",
  entity: "Banco Hipotecario",
  scope: "common",
  memberId: "",
  principal: "12.000.000",
  annualRate: "",
};

/** Empty date mirrors the zod transform: "" → today. */
const payment = (amount: string, date = "", memberId = ""): LoanPaymentInput => ({
  amount,
  date: date || todayIso(),
  note: "",
  memberId,
});

describe("loans helpers (pure)", () => {
  it("computes outstanding and paid percentage", () => {
    expect(computeOutstanding(850_000, 12_500, 300_000)).toBe(562_500);
    // Overpaid: outstanding can go negative; UI clamps, math stays exact.
    expect(computeOutstanding(100_000, 0, 150_000)).toBe(-50_000);
    // 0 when principal <= 0 (division guard).
    expect(computePaidPct(1_000_000, 250_000)).toBe(25);
    expect(computePaidPct(0, 500)).toBe(0);
    expect(computePaidPct(-100, 500)).toBe(0);
  });
});

describe("loans CRUD (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    await db.insert(categories).values({ name: "Pago de préstamos", kind: "expense" });
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
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates loans with AR-formatted principal, entity and optional TNA", async () => {
    expect(
      await createLoan(appDb, admin, { ...cardInput, annualRate: "45" }),
    ).toEqual({ ok: true });
    expect(await createLoan(appDb, admin, mortgageInput)).toEqual({ ok: true });

    const loanRows = await listLoans(appDb);
    expect(loanRows.map((l) => l.name)).toEqual(["Hipoteca casa", "Visa Banco Nación"]);
    const card = loanRows.find((l) => l.kind === "credit_card");
    expect(card).toMatchObject({
      entity: "Visa Banco Nación",
      principalCents: 85_000_000,
      annualRateBp: 4500,
      paidCents: 0,
      interestCents: 0,
      outstandingCents: 85_000_000,
      paidPct: 0,
      paymentCount: 0,
    });
    const mortgage = loanRows.find((l) => l.kind === "mortgage");
    expect(mortgage).toMatchObject({ annualRateBp: null, outstandingCents: 1_200_000_000 });
  });

  it("mirrors the scope CHECK at the zod level", async () => {
    const parsed = loanSchema.safeParse({ ...cardInput, scope: "individual" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.find((i) => i.path[0] === "memberId")?.message).toBe(
      "Los préstamos individuales requieren un integrante.",
    );

    const withMember = loanSchema.safeParse({ ...cardInput, memberId });
    expect(withMember.success).toBe(false);
  });

  it("validates entity, principal and TNA at the trust boundary", async () => {
    // Entity is required and capped at 64 chars.
    expect(loanSchema.safeParse({ ...cardInput, entity: "" }).success).toBe(false);
    expect(loanSchema.safeParse({ ...cardInput, entity: "x".repeat(65) }).success).toBe(false);
    // Principal is required and positive.
    expect(loanSchema.safeParse({ ...cardInput, principal: "" }).success).toBe(false);
    expect(await createLoan(appDb, admin, { ...cardInput, name: "P0", principal: "0" })).toEqual({
      ok: false,
      error: "invalid_principal",
    });
    expect(await createLoan(appDb, admin, { ...cardInput, name: "PN", principal: "-5" })).toEqual({
      ok: false,
      error: "invalid_principal",
    });
    expect(await createLoan(appDb, admin, { ...cardInput, name: "PX", principal: "pepes" })).toEqual({
      ok: false,
      error: "invalid_principal",
    });
    // AR-tolerant TNA: "35,5" → 3550 bp; caps at 1000%.
    expect(loanSchema.safeParse({ ...cardInput, annualRate: "35,5" }).success).toBe(true);
    expect(await createLoan(appDb, admin, { ...cardInput, name: "R1", annualRate: "1000,01" })).toEqual({
      ok: false,
      error: "invalid_rate",
    });
    expect(await createLoan(appDb, admin, { ...cardInput, name: "R2", annualRate: "999,99" })).toEqual({
      ok: true,
    });
  });

  it("updates name, kind, entity, scope, member, principal and rate", async () => {
    const [row] = await db.select().from(loans).where(eq(loans.name, "Hipoteca casa"));

    expect(
      await updateLoan(appDb, admin, row.id, {
        ...mortgageInput,
        name: "Hipoteca depto",
        entity: "Banco Provincia",
        scope: "individual",
        memberId,
        principal: "10.000.000",
        annualRate: "8,5",
      }),
    ).toEqual({ ok: true });
    const [after] = await db.select().from(loans).where(eq(loans.id, row.id));
    expect(after).toMatchObject({
      name: "Hipoteca depto",
      entity: "Banco Provincia",
      scope: "individual",
      memberId,
      principalCents: 1_000_000_000,
      annualRateBp: 850,
    });
  });

  it("reports typed errors for unknown ids", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await updateLoan(appDb, admin, ghostId, cardInput)).toEqual({
      ok: false,
      error: "loan_not_found",
    });
    expect(await toggleLoanActive(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "loan_not_found",
    });
    expect(await removeLoan(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "loan_not_found",
    });
    expect(await updateOutstanding(appDb, admin, ghostId, "100")).toEqual({
      ok: false,
      error: "loan_not_found",
    });
  });

  it("deleting a loan with payments fails typed; a clean one succeeds; toggle flips", async () => {
    await createLoan(appDb, admin, { ...cardInput, name: "ConPagos" });
    const [withRows] = await db.select().from(loans).where(eq(loans.name, "ConPagos"));
    expect(await addLoanPayment(appDb, admin, withRows.id, payment("100"))).toEqual({ ok: true });

    expect(await removeLoan(appDb, admin, withRows.id)).toEqual({ ok: false, error: "has_payments" });
    expect(await db.select().from(loans).where(eq(loans.id, withRows.id))).toHaveLength(1);

    await createLoan(appDb, admin, { ...cardInput, name: "Limpio" });
    const [clean] = await db.select().from(loans).where(eq(loans.name, "Limpio"));
    expect(await toggleLoanActive(appDb, admin, clean.id)).toEqual({ ok: true });
    let after = await db.select().from(loans).where(eq(loans.id, clean.id));
    expect(after[0].isActive).toBe(false);

    expect(await removeLoan(appDb, admin, clean.id)).toEqual({ ok: true });
    after = await db.select().from(loans).where(eq(loans.id, clean.id));
    expect(after).toHaveLength(0);
  });

  it("enforces the admin/member authorization matrix at service level", async () => {
    // Members can never manage loans or balances.
    expect(await createLoan(appDb, member, cardInput)).toEqual({ ok: false, error: "forbidden" });
    const [row] = await db.select().from(loans).where(eq(loans.name, "Visa Banco Nación"));
    expect(await updateLoan(appDb, member, row.id, cardInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await toggleLoanActive(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await removeLoan(appDb, member, row.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await updateOutstanding(appDb, member, row.id, "100")).toEqual({
      ok: false,
      error: "forbidden",
    });

    // Payments are open to members, but PINNED to themselves.
    expect(await addLoanPayment(appDb, member, row.id, payment("50"))).toEqual({ ok: true });
    expect(await addLoanPayment(appDb, member, row.id, payment("50", "", admin.id))).toEqual({
      ok: false,
      error: "forbidden",
    });
    // Admins may attribute to any member.
    expect(await addLoanPayment(appDb, admin, row.id, payment("70", "", memberId))).toEqual({
      ok: true,
    });
  });

  it("rejects payments to unknown or inactive loans and bad amounts", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await addLoanPayment(appDb, admin, ghostId, payment("100"))).toEqual({
      ok: false,
      error: "loan_not_found",
    });

    await createLoan(appDb, admin, { ...cardInput, name: "Pausada" });
    const [row] = await db.select().from(loans).where(eq(loans.name, "Pausada"));
    await toggleLoanActive(appDb, admin, row.id);
    expect(await addLoanPayment(appDb, member, row.id, payment("100"))).toEqual({
      ok: false,
      error: "loan_inactive",
    });

    const parsed = loanPaymentSchema.safeParse({ ...payment("100"), amount: "" });
    expect(parsed.success).toBe(false);
    expect(await addLoanPayment(appDb, member, row.id, payment("-5"))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(await addLoanPayment(appDb, member, row.id, payment("abc"))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
  });

  it("lists payments newest first with member attribution", async () => {
    const [row] = await db.select().from(loans).where(eq(loans.name, "Visa Banco Nación"));
    await db.insert(loanPayments).values([
      { loanId: row.id, memberId, kind: "payment", amountCents: 1234, date: "2026-05-01" },
      { loanId: row.id, memberId, kind: "payment", amountCents: 2345, date: "2026-05-02" },
    ]);

    const list = await listPayments(appDb, row.id);
    expect(list).toHaveLength(4);
    expect(list[0]?.date).toBe(todayIso());
    expect(list.slice(-2).map((p) => [p.date, p.memberName, p.amountCents, p.kind])).toEqual([
      ["2026-05-02", "Mate", 2345, "payment"],
      ["2026-05-01", "Mate", 1234, "payment"],
    ]);
  });

  it("aggregates paid, interest, outstanding and paidPct per loan", async () => {
    const loanRows = await listLoans(appDb);
    const card = loanRows.find((l) => l.name === "Visa Banco Nación")!;
    // 5000 (member, pinned) + 7000 (admin, attributed) + 1234 + 2345 direct rows.
    expect(card).toMatchObject({
      paidCents: 15_579,
      interestCents: 0,
      outstandingCents: 85_000_000 - 15_579,
      paymentCount: 4,
    });
    // percentage() rounds to 2 decimals.
    expect(card.paidPct).toBe(0.02);
  });
});

describe("payment mirrors and true-ups (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    await db
      .insert(categories)
      .values({ name: "Pago de préstamos", kind: "expense" });
    const [row] = await db
      .insert(users)
      .values({ username: "admin2", name: "Admin2", passwordHash: "x", role: "admin" })
      .returning();
    await db.insert(users).values({ username: "nico", name: "Nico", passwordHash: "x", role: "member" });
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };

    expect(
      await createLoan(appDb, admin, {
        ...cardInput,
        name: "Espejo",
        entity: "Banco Espejo",
        principal: "1.000",
        annualRate: "35,5",
      }),
    ).toEqual({ ok: true });
  });

  afterAll(async () => {
    await client.close();
  });

  const mirrorLoan = async () => {
    const [row] = await db.select().from(loans).where(eq(loans.name, "Espejo"));
    return row;
  };

  it("payments mirror an expense; interest rows never do (R1)", async () => {
    const loan = await mirrorLoan();

    expect(await addLoanPayment(appDb, admin, loan.id, payment("100", "2026-09-10"))).toEqual({
      ok: true,
    });

    const movements = await db
      .select({
        type: transactions.type,
        amountCents: transactions.amountCents,
        date: transactions.date,
        note: transactions.note,
        scope: transactions.scope,
        memberId: transactions.memberId,
        categoryName: categories.name,
      })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .innerJoin(loanPayments, eq(transactions.loanPaymentId, loanPayments.id))
      .where(eq(loanPayments.loanId, loan.id));

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "expense",
      amountCents: 10_000,
      date: "2026-09-10",
      scope: "common",
      memberId: admin.id,
      categoryName: "Pago de préstamos",
      note: "Pago Espejo",
    });

    // Interest rows never mirror: insert one directly, mirror count unchanged.
    await db.insert(loanPayments).values({
      loanId: loan.id,
      kind: "interest",
      amountCents: 999,
      date: "2026-09-01",
    });
    expect(movements).toHaveLength(1);

    // R1 proof: totals see the mirror — Saldo dropped by the payment.
    const totals = await transactionTotals(appDb);
    expect(totals.expenseCents).toBeGreaterThanOrEqual(10_000);
    expect(totals.balanceCents).toBe(totals.incomeCents - totals.expenseCents);
  });

  it("links every mirror to its payment and cascades on delete", async () => {
    const loan = await mirrorLoan();
    const paymentsBefore = await db
      .select({ id: loanPayments.id })
      .from(loanPayments)
      .where(eq(loanPayments.loanId, loan.id));
    const linked = await db
      .select({ paymentId: transactions.loanPaymentId })
      .from(transactions);
    const paymentIds = new Set(paymentsBefore.map((p) => p.id));
    for (const link of linked) {
      if (link.paymentId !== null) expect(paymentIds.has(link.paymentId)).toBe(true);
    }

    // Deleting a payment removes its mirror via FK CASCADE.
    const [first] = paymentsBefore;
    await db.delete(loanPayments).where(eq(loanPayments.id, first.id));
    const after = await db.select().from(transactions);
    expect(after.filter((t) => t.loanPaymentId === first.id)).toHaveLength(0);
  });

  it("true-up writes one 'Ajuste de saldo' row in both directions", async () => {
    const loan = await mirrorLoan();
    // The service payment was deleted in the previous test:
    // outstanding = 100000 (principal) + 999 (interest) = 100999.
    let loanRows = await listLoans(appDb);
    expect(loanRows.find((l) => l.id === loan.id)).toMatchObject({ outstandingCents: 100_999 });

    // Statement says $800 → delta −20999: ONE negative interest entry.
    expect(await updateOutstanding(appDb, admin, loan.id, "800")).toEqual({ ok: true });
    loanRows = await listLoans(appDb);
    expect(loanRows.find((l) => l.id === loan.id)).toMatchObject({ outstandingCents: 80_000 });
    let rows = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, loan.id));
    const ajustes = rows.filter((r) => r.note === "Ajuste de saldo");
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0]).toMatchObject({ kind: "interest", memberId: null, amountCents: -20_999 });

    // Statement says $1.000 → delta +20000: positive entry, same day converges.
    expect(await updateOutstanding(appDb, admin, loan.id, "1.000")).toEqual({ ok: true });
    loanRows = await listLoans(appDb);
    expect(loanRows.find((l) => l.id === loan.id)).toMatchObject({ outstandingCents: 100_000 });
    rows = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id));
    expect(rows.filter((r) => r.note === "Ajuste de saldo")).toHaveLength(1);

    // Re-stating the SAME value replaces the entry with the identical net
    // delta (raw 100999 − stated 100000 = −999) — converged, one row.
    expect(await updateOutstanding(appDb, admin, loan.id, "1000")).toEqual({ ok: true });
    rows = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id));
    const converged = rows.filter((r) => r.note === "Ajuste de saldo");
    expect(converged).toHaveLength(1);
    expect(converged[0].amountCents).toBe(-999);

    // Invalid stated balance → typed error.
    expect(await updateOutstanding(appDb, admin, loan.id, "-1")).toEqual({
      ok: false,
      error: "invalid_outstanding",
    });
    expect(await updateOutstanding(appDb, admin, loan.id, "jaja")).toEqual({
      ok: false,
      error: "invalid_outstanding",
    });
    expect(outstandingSchema.safeParse("").success).toBe(false);
  });
});

describe("patrimony includes debt (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "p-admin", passwordHash: "x", name: "P", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    await db.insert(categories).values({ name: "Pago de préstamos", kind: "expense" });
  });

  afterAll(async () => {
    await client.close();
  });

  it("net drops by the outstanding after creating a loan and after a payment", async () => {
    const before = await getPatrimony(appDb);
    expect(before.debtCents).toBe(0);
    expect(before.totalCents).toBe(before.savingsCents + before.investmentsCents);

    expect(await createLoan(appDb, admin, { ...cardInput, name: "Deuda", principal: "500" })).toEqual({
      ok: true,
    });

    const withDebt = await getPatrimony(appDb);
    expect(withDebt.debtCents).toBe(50_000);
    expect(withDebt.totalCents).toBe(before.savingsCents + before.investmentsCents - 50_000);
    await expect(getDebtCents(appDb)).resolves.toBe(50_000);

    // Paying back reduces the debt (and the net rises accordingly).
    const [loan] = await db.select().from(loans).where(eq(loans.name, "Deuda"));
    expect(await addLoanPayment(appDb, admin, loan.id, payment("200"))).toEqual({ ok: true });
    const afterPayment = await getPatrimony(appDb);
    expect(afterPayment.debtCents).toBe(30_000);
    expect(afterPayment.totalCents).toBe(before.savingsCents + before.investmentsCents - 30_000);
  });

  it("includes inactive loans in the debt (deactivating does not forgive)", async () => {
    const [loan] = await db.select().from(loans).where(eq(loans.name, "Deuda"));
    await toggleLoanActive(appDb, admin, loan.id);
    expect(await getDebtCents(appDb)).toBe(30_000);
    await toggleLoanActive(appDb, admin, loan.id);
  });
});

describe("payments without system category (isolated DB)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "solo-admin", passwordHash: "x", name: "S", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    expect(await createLoan(appDb, admin, { ...cardInput, name: "SinCategorias" })).toEqual({
      ok: true,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it("fails typed and atomically when the mirror category does not exist", async () => {
    const [fresh] = await db.select().from(loans).where(eq(loans.name, "SinCategorias"));

    expect(await addLoanPayment(appDb, admin, fresh.id, payment("50"))).toEqual({
      ok: false,
      error: "system_category_missing",
    });
    const leftovers = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, fresh.id));
    expect(leftovers).toHaveLength(0); // nothing half-written
  });
});
