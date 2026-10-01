import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, and, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, loanPayments, loans, transactions, users } from "@/db/schema";
import {
  addCardPayment,
  addLoanPayment,
  CARD_FEE_NOTE,
  CARD_INTEREST_NOTE,
  computeOutstanding,
  computePaidPct,
  createLoan,
  getDebtCents,
  listCardCycles,
  loanPaymentSchema,
  loanSchema,
  listLoans,
  listLoanPeriods,
  listPayments,
  outstandingSchema,
  removeLedgerEntry,
  removeLoan,
  toggleLoanActive,
  updateLoan,
  updateOutstanding,
  type CardPaymentInput,
  type LoanInput,
  type LoanPaymentInput,
} from "@/features/loans/service";
import { getPatrimony } from "@/features/savings/service";
import { transactionTotals } from "@/features/transactions/service";
import { todayIso } from "@/lib/date";
import type { SessionUser } from "@/lib/auth";
import { catchUpAllLoanInterest, catchUpBankInterest } from "@/features/loans/accrual";
import { allocateWaterfall } from "@/features/loans/amortization";
import {
  COMPOUNDED_33_DAY_INTEREST_CENTS,
  GOLDEN,
  seedGoldenBankLoan,
} from "@/features/loans/golden-fixture";

/**
 * Loans service suite: loan CRUD + scope CHECK, outstanding math in exact
 * cents, member pinning, mirror transactions (R1), manual balance true-ups,
 * net patrimony and the full admin/member authorization matrix — against
 * in-memory Postgres with the real migrations. The bank-mode blocks cover
 * the calibration gate (D4), charge-aware aggregation (D5), the period
 * statement and the golden reconciliation (R2 amendment).
 */

/** Empty bank fields keep the simple-mode literals valid after the D4 widening. */
const emptyBank = {
  amortizationMode: "",
  chargedRate: "",
  contractualRate: "",
  termMonths: "",
  fixedCuota: "",
  cuotaDay: "",
  propertyValue: "",
  insuredBase: "",
  lifeRatePerMillon: "",
  fireRatePerMillon: "",
  moraRate: "",
  otherCharges: "",
  creditLimit: "",
  managementFee: "",
  statementDay: "",
} as const;

const cardInput: LoanInput = {
  name: "Visa Banco Nación",
  kind: "credit_card",
  entity: "Visa Banco Nación",
  scope: "common",
  memberId: "",
  principal: "850.000,00",
  annualRate: "",
  ...emptyBank,
};

const mortgageInput: LoanInput = {
  name: "Hipoteca casa",
  kind: "mortgage",
  entity: "Banco Hipotecario",
  scope: "common",
  memberId: "",
  principal: "12.000.000",
  annualRate: "",
  ...emptyBank,
};

/** Golden Davivienda calibration (statement snapshot, back-computed rates). */
const bankInput: LoanInput = {
  name: "Hipoteca Davivienda",
  kind: "mortgage",
  entity: "Davivienda",
  scope: "common",
  memberId: "",
  principal: "2.049.934,15",
  annualRate: "",
  amortizationMode: "bank",
  chargedRate: "12,95",
  contractualRate: "17,47",
  termMonths: "228",
  fixedCuota: "2.628.000,00",
  cuotaDay: "25",
  propertyValue: "339.802.600,00",
  insuredBase: "204.993.414,80",
  lifeRatePerMillon: "471,32",
  fireRatePerMillon: "218,17",
  moraRate: "",
  otherCharges: "",
  creditLimit: "",
  managementFee: "",
  statementDay: "",
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
    // Shared guided path: '1.234' asks for disambiguation, not a guess.
    expect(await addLoanPayment(appDb, member, row.id, payment("1.234"))).toEqual({
      ok: false,
      error: "ambiguous_amount",
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
        principal: "1.000,00",
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
    expect(await updateOutstanding(appDb, admin, loan.id, "1.000,00")).toEqual({ ok: true });
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

describe("bank loan configuration — zod gate (D4)", () => {
  it("accepts the full bank calibration and parses the mode field", () => {
    const parsed = loanSchema.safeParse(bankInput);
    expect(parsed.success).toBe(true);
  });

  it("bank mode requires the four core config fields (incomplete config rejected)", () => {
    for (const field of ["chargedRate", "fixedCuota", "termMonths", "cuotaDay"] as const) {
      const parsed = loanSchema.safeParse({ ...bankInput, [field]: "" });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues.find((i) => i.path[0] === field)).toBeTruthy();
    }
  });

  it("simple mode must carry NO bank config (zod mirrors the DB CHECK)", () => {
    expect(loanSchema.safeParse({ ...cardInput, amortizationMode: "" }).success).toBe(true);
    expect(
      loanSchema.safeParse({ ...cardInput, amortizationMode: "", chargedRate: "12,95" }).success,
    ).toBe(false);
  });

  it("rejects unknown amortization modes at the field level", () => {
    const parsed = loanSchema.safeParse({ ...bankInput, amortizationMode: "francés" });
    expect(parsed.success).toBe(false);
  });
});

describe("bank loan configuration — service roundtrip (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "bank-admin", name: "B", passwordHash: "x", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a bank loan with AR-formatted calibration, exact integer columns", async () => {
    expect(await createLoan(appDb, admin, bankInput)).toEqual({ ok: true });

    const [row] = await db.select().from(loans).where(eq(loans.name, "Hipoteca Davivienda"));
    expect(row).toMatchObject({
      amortizationMode: "bank",
      chargedRateBp: 1295, // "12,95" %
      contractualRateBp: 1747, // "17,47" % (display-only)
      termMonths: 228,
      fixedCuotaCents: 262_800_000, // $2.628.000,00
      cuotaDay: 25,
      propertyValueCents: 33_980_260_000,
      insuredBaseCents: 20_499_341_480,
      // per-millón "471,32" → 47132 cents × 1000 = 47.132.000 (×100k basis)
      lifeInsuranceRatePerMillonX100k: 47_132_000,
      fireInsuranceRatePerMillonX100k: 21_817_000,
      moraRateBp: null,
      otherChargesCents: null,
    });
  });

  it("switches a loan between bank and simple modes on update", async () => {
    const [row] = await db.select().from(loans).where(eq(loans.name, "Hipoteca Davivienda"));

    expect(await updateLoan(appDb, admin, row.id, { ...bankInput, ...emptyBank })).toEqual({
      ok: true,
    });
    let [after] = await db.select().from(loans).where(eq(loans.id, row.id));
    expect(after.amortizationMode).toBeNull();
    expect(after.chargedRateBp).toBeNull();
    expect(after.fixedCuotaCents).toBeNull();

    expect(await updateLoan(appDb, admin, row.id, bankInput)).toEqual({ ok: true });
    [after] = await db.select().from(loans).where(eq(loans.id, row.id));
    expect(after).toMatchObject({ amortizationMode: "bank", chargedRateBp: 1295 });
  });

  it("rejects out-of-range bank numerics with a typed field error", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ cuotaDay: "29" }, "cuotaDay"],
      [{ cuotaDay: "0" }, "cuotaDay"],
      [{ cuotaDay: "pepes" }, "cuotaDay"],
      [{ termMonths: "0" }, "termMonths"],
      [{ termMonths: "abc" }, "termMonths"],
      [{ fixedCuota: "0" }, "fixedCuota"],
      [{ fixedCuota: "x" }, "fixedCuota"],
      [{ chargedRate: "1000,01" }, "chargedRate"], // > 1000% EA
      [{ chargedRate: "no" }, "chargedRate"],
      [{ moraRate: "1000,01" }, "moraRate"],
      [{ contractualRate: "bad" }, "contractualRate"],
      [{ propertyValue: "-5" }, "propertyValue"], // CHECK >= 0
      [{ insuredBase: "-1" }, "insuredBase"],
      [{ otherCharges: "-1" }, "otherCharges"],
      [{ lifeRatePerMillon: "10.000,00" }, "lifeRatePerMillon"], // 1e9 > CHECK bound
      [{ fireRatePerMillon: "zz" }, "fireRatePerMillon"],
    ];
    for (const [overrides, field] of cases) {
      const name = `Inválida ${field} ${JSON.stringify(overrides[field] ?? "")}`;
      expect(await createLoan(appDb, admin, { ...bankInput, name, ...overrides })).toEqual({
        ok: false,
        error: "invalid_bank_config",
        field,
      });
    }
  });
});

/** Golden Davivienda constants and the seed helper live in the shared
 * golden-fixture module (used by accrual.test.ts and amortization.test.ts too). */

describe("golden reconciliation — period statement (R2 amendment, integration)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let payerId: string;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [payer] = await db
      .insert(users)
      .values({ username: "golden-payer", passwordHash: "x", name: "Golden Payer" })
      .returning();
    payerId = payer.id;
    const [row] = await db
      .insert(users)
      .values({ username: "golden-admin", passwordHash: "x", name: "Golden Admin", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
  });

  afterAll(async () => {
    await client.close();
  });

  const ledgerOf = (loanId: string) =>
    db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId)).orderBy(asc(loanPayments.date));

  it("engine interest over the 33-day window equals the compounded formula EXACTLY", async () => {
    // Components OFF: the 33 days accrue over the unaugmented saldo0, which
    // is exactly the statement's interest-line basis.
    const loanId = await seedGoldenBankLoan(db, { name: "Dorada 33", principalCents: GOLDEN.saldo0Cents });
    await catchUpBankInterest(appDb, loanId, new Date("2026-02-13T12:00:00Z")); // yesterday 02-12

    const rows = (await ledgerOf(loanId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(GOLDEN.days);

    // Independent recomputation of the pure daily-compound formula.
    const factor = Math.pow(1 + GOLDEN.chargedRateBp / 10000, 1 / 365) - 1;
    let saldo = GOLDEN.saldo0Cents;
    const expected = rows.map(() => {
      const cents = Math.round(saldo * factor);
      saldo += cents;
      return cents;
    });
    expect(rows.map((r) => r.amountCents)).toEqual(expected);
    expect(rows[0].amountCents).toBe(6_840_342);
    expect(rows.at(-1)!.amountCents).toBe(6_913_762);

    const sum = rows.reduce((acc, r) => acc + r.amountCents, 0);
    expect(sum).toBe(COMPOUNDED_33_DAY_INTEREST_CENTS);

    // Closed form (1+EA)^(33/365)−1 differs only by accumulated rounding:
    // the amendment bound is ≤ 1 cent per accrued day.
    const closedForm = GOLDEN.saldo0Cents * (Math.pow(1 + GOLDEN.chargedRateBp / 10000, 33 / 365) - 1);
    expect(Math.abs(sum - closedForm)).toBeLessThanOrEqual(GOLDEN.days);
  });

  it("cuota identity is EXACT over engine values; the bank delta is RECORDED, never asserted", async () => {
    // Engine-produced components at golden scale: the first anchor's charges
    // run on the period-start saldo (saldo0) and the constant property value.
    const loanId = await seedGoldenBankLoan(db, {
      name: "Dorada componentes",
      principalCents: GOLDEN.saldo0Cents,
      lifeX100k: GOLDEN.lifeRateX100k,
      fireX100k: GOLDEN.fireRateX100k,
      propertyCents: GOLDEN.propertyCents,
    });
    await catchUpBankInterest(appDb, loanId, new Date("2026-01-26T12:00:00Z")); // anchor 01-25

    const charges = (await ledgerOf(loanId)).filter((r) => r.kind === "charge");
    const vida = charges.find((r) => r.note === "Seguro de vida")!.amountCents;
    const incendio = charges.find((r) => r.note === "Seguro de incendio")!.amountCents;
    expect(vida).toBe(GOLDEN.vidaCents); // back-computed rate ⇒ exact 96.617,00
    expect(incendio).toBe(GOLDEN.incendioCents); // exact 74.136,00

    // Cuota identity EXACT (R2 amendment #1): capital is the exact residual.
    const { capitalCents } = allocateWaterfall(
      GOLDEN.cuotaCents,
      vida + incendio,
      0,
      0,
      COMPOUNDED_33_DAY_INTEREST_CENTS,
    );
    expect(vida + incendio + COMPOUNDED_33_DAY_INTEREST_CENTS + capitalCents).toBe(GOLDEN.cuotaCents);
    expect(capitalCents).toBe(18_784_062); // $187.840,62 — the golden residual
    expect(capitalCents).toBe(
      GOLDEN.cuotaCents - (vida + incendio + COMPOUNDED_33_DAY_INTEREST_CENTS),
    );

    // Bank delta (R2 amendment #4): recorded in the output, NOT asserted
    // equal — the drift is absorbed operationally by the true-up.
    const delta = {
      engineInterestCents: COMPOUNDED_33_DAY_INTEREST_CENTS,
      bankStatedInterestCents: GOLDEN.bankStatedInterestCents,
      deltaCents: COMPOUNDED_33_DAY_INTEREST_CENTS - GOLDEN.bankStatedInterestCents,
    };
    console.info("[golden] engine vs bank statement interest line:", delta);
  });

  it("listLoanPeriods renders the 5 sections and the saldo identity EXACTLY (golden period 1)", async () => {
    const loanId = await seedGoldenBankLoan(db, {
      name: "Dorada período",
      principalCents: GOLDEN.saldo0Cents,
      lifeX100k: GOLDEN.lifeRateX100k,
      fireX100k: GOLDEN.fireRateX100k,
      propertyCents: GOLDEN.propertyCents,
    });
    // The full cuota is paid ON the anchor (a due-date payment is on time).
    await db.insert(loanPayments).values({
      loanId,
      memberId: payerId,
      kind: "payment",
      amountCents: GOLDEN.cuotaCents,
      date: "2026-01-25",
    });
    await catchUpBankInterest(appDb, loanId, new Date("2026-01-26T12:00:00Z"));

    const periods = await listLoanPeriods(appDb, loanId);
    expect(periods).toHaveLength(1); // period 2 is still open (no anchor yet)

    const period = periods[0]!;
    expect(period.startDate).toBe("2026-01-10"); // first period opens at creation
    expect(period.endDate).toBe("2026-01-25"); // the closing anchor
    expect(period.cuotaCents).toBe(GOLDEN.cuotaCents);
    expect(period.sections).toEqual({
      segurosCents: GOLDEN.vidaCents + GOLDEN.incendioCents,
      otrosCargosCents: 0,
      moraCents: 0,
      interesesCents: 102_845_147, // 15 daily rows 01-11..01-25 over saldo0
      capitalCents: GOLDEN.cuotaCents - (GOLDEN.vidaCents + GOLDEN.incendioCents + 102_845_147),
    });
    expect(period.paymentsCents).toBe(GOLDEN.cuotaCents);
    expect(period.saldoBeforeCents).toBe(GOLDEN.saldo0Cents);
    // Saldo identity EXACT (R2 amendment #2): after = before − capital.
    expect(period.saldoAfterCents).toBe(20_356_461_927);
    expect(period.saldoAfterCents).toBe(period.saldoBeforeCents - period.sections.capitalCents);
  });

  it("sections classify note-keyed charges (seguros / otros / mora) and periods come newest first", async () => {
    const loanId = await seedGoldenBankLoan(db, {
      name: "Dorada mora",
      principalCents: 100_000_000,
      lifeX100k: 46_790_000,
      fireX100k: 18_330_000,
      otrosCents: 1_234_567,
      propertyCents: GOLDEN.propertyCents,
      moraRateBp: 3650,
    });
    // Nobody pays: anchors 01-25 and 02-25 close, mora accrues unpaid.
    await catchUpBankInterest(appDb, loanId, new Date("2026-02-26T12:00:00Z"));

    const rows = await ledgerOf(loanId);
    const byNote = (note: string) =>
      rows.filter((r) => r.note === note).reduce((acc, r) => acc + r.amountCents, 0);
    const engineInterest = rows
      .filter((r) => r.kind === "interest")
      .reduce((acc, r) => acc + r.amountCents, 0);
    // Mora rows live strictly past the anchor they penalize ⇒ period 2.
    const moraAfterAnchor = rows
      .filter((r) => r.note === "Mora" && r.date > "2026-01-25")
      .reduce((acc, r) => acc + r.amountCents, 0);
    expect(moraAfterAnchor).toBeGreaterThan(0);

    const periods = await listLoanPeriods(appDb, loanId);
    expect(periods).toHaveLength(2);
    expect(periods.map((p) => p.endDate)).toEqual(["2026-02-25", "2026-01-25"]); // newest first

    const [p2, p1] = periods;
    // Period 1: seguros + otros materialize at the 01-25 close, no mora yet.
    expect(p1.sections).toMatchObject({
      segurosCents: 46_790 + 6_228_582,
      otrosCargosCents: 1_234_567,
      moraCents: 0,
    });
    expect(p1.saldoBeforeCents).toBe(100_000_000);
    expect(p1.paymentsCents).toBe(0);
    // Capital formula: cuota − every other section (waterfall contract).
    expect(p1.sections.capitalCents).toBe(
      GOLDEN.cuotaCents -
        (p1.sections.segurosCents + p1.sections.otrosCargosCents + p1.sections.moraCents + p1.sections.interesesCents),
    );

    // Period 2 carries the mora section on its own, never inside the cuota lines.
    expect(p2.sections.moraCents).toBe(byNote("Mora"));
    expect(p2.sections.segurosCents).toBeGreaterThan(0);
    expect(p2.sections.interesesCents).toBeGreaterThan(0);
    // Global conservation: every engine cent lands in exactly one section.
    const allSections = periods.reduce(
      (acc, p) =>
        acc +
        p.sections.segurosCents +
        p.sections.otrosCargosCents +
        p.sections.moraCents +
        p.sections.interesesCents,
      0,
    );
    expect(allSections).toBe(byNote("Seguro de vida") + byNote("Seguro de incendio") + byNote("Otros cargos") + byNote("Mora") + engineInterest);
    // Saldo walk: each period starts where the previous one ended.
    expect(p2.saldoBeforeCents).toBe(p1.saldoAfterCents);
  });

  it("returns [] for simple loans, unknown ids and ledgers without a closed anchor", async () => {
    expect(await createLoan(appDb, admin, cardInput)).toEqual({ ok: true });
    const [simple] = await db.select().from(loans).where(eq(loans.name, "Visa Banco Nación"));
    expect(await listLoanPeriods(appDb, simple.id)).toEqual([]);

    expect(
      await listLoanPeriods(appDb, "00000000-0000-4000-8000-000000000000"),
    ).toEqual([]);

    // Bank loan whose rows never reached an anchor: the open tail is not a
    // closed cuota, so the statement stays empty.
    const loanId = await seedGoldenBankLoan(db, { name: "Dorada abierta", principalCents: GOLDEN.saldo0Cents });
    await db.insert(loanPayments).values({
      loanId,
      memberId: payerId,
      kind: "payment",
      amountCents: 500_000,
      date: "2026-01-15",
    });
    expect(await listLoanPeriods(appDb, loanId)).toEqual([]);
  });

  it("listLoans and the true-up are charge-aware: unpaid charges are debt (D5)", async () => {
    const loanId = await seedGoldenBankLoan(db, {
      name: "Dorada agregación",
      principalCents: GOLDEN.saldo0Cents,
      lifeX100k: GOLDEN.lifeRateX100k,
      fireX100k: GOLDEN.fireRateX100k,
      propertyCents: GOLDEN.propertyCents,
    });
    await db.insert(loanPayments).values({
      loanId,
      memberId: payerId,
      kind: "payment",
      amountCents: GOLDEN.cuotaCents,
      date: "2026-01-25",
    });
    await catchUpBankInterest(appDb, loanId, new Date("2026-01-26T12:00:00Z"));

    const loanRows = await listLoans(appDb);
    const golden = loanRows.find((l) => l.id === loanId)!;
    const rows = await ledgerOf(loanId);
    const ledgerCharges = rows
      .filter((r) => r.kind === "charge")
      .reduce((acc, r) => acc + r.amountCents, 0);
    const ledgerInterest = rows
      .filter((r) => r.kind === "interest")
      .reduce((acc, r) => acc + r.amountCents, 0);

    expect(golden.chargesCents).toBe(ledgerCharges);
    expect(golden.interestCents).toBe(ledgerInterest);
    // outstanding = principal + interest + CHARGES − payments (D5).
    expect(golden.outstandingCents).toBe(
      GOLDEN.saldo0Cents + ledgerInterest + ledgerCharges - GOLDEN.cuotaCents,
    );

    // The true-up converges to the stated saldo INCLUDING the charges.
    const stated = golden.outstandingCents + 5_000_000;
    expect(
      await updateOutstanding(appDb, admin, loanId, (stated / 100).toFixed(2).replace(".", ",")),
    ).toEqual({ ok: true });
    const after = (await listLoans(appDb)).find((l) => l.id === loanId)!;
    expect(after.outstandingCents).toBe(stated);
  });
});

describe("revolving cards (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let payerId: string;
  let categoryId: string;
  let cardId: string;
  let otherLoanId: string;

  /** Fresh revolving form input; per-test overrides layered on top. */
  const revolvingInput = (over: Partial<LoanInput> = {}): LoanInput => ({
    name: "Visa Oro",
    kind: "credit_card",
    entity: "Banco Nación",
    scope: "common",
    memberId: "",
    principal: "0,00",
    annualRate: "",
    amortizationMode: "revolving",
    chargedRate: "",
    contractualRate: "",
    termMonths: "",
    fixedCuota: "",
    cuotaDay: "",
    propertyValue: "",
    insuredBase: "",
    lifeRatePerMillon: "",
    fireRatePerMillon: "",
    moraRate: "",
    otherCharges: "",
    creditLimit: "1.000.000,00",
    managementFee: "50.000,00",
    statementDay: "25",
    ...over,
  });

  const cardPayment = (
    amount: string,
    over: Partial<CardPaymentInput> = {},
  ): CardPaymentInput => ({
    amount,
    interest: "",
    includeFee: "",
    date: todayIso(),
    note: "",
    memberId: "",
    ...over,
  });

  /** Direct card purchase (the transactions service writes these in T3). */
  async function purchase(cents: number, date = "2026-09-10") {
    await db.insert(transactions).values({
      date,
      amountCents: cents,
      type: "expense",
      categoryId,
      memberId: payerId,
      paymentMethod: "card",
      cardLoanId: cardId,
    });
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    await db.insert(categories).values([
      { name: "Pago de préstamos", kind: "expense" },
      { name: "Pago de tarjetas", kind: "expense" },
      { name: "Intereses de tarjetas", kind: "expense" },
      { name: "Cuota de manejo de tarjetas", kind: "expense" },
      { name: "Supermercado", kind: "expense" },
    ]);
    const [row] = await db
      .insert(users)
      .values({ username: "radmin", name: "RAdmin", passwordHash: "x", role: "admin" })
      .returning();
    const [mate] = await db
      .insert(users)
      .values({ username: "rmate", name: "RMate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    member = { id: mate.id, username: mate.username, name: mate.name, role: mate.role };
    payerId = mate.id;
    const [cat] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, "Supermercado"))
      .limit(1);
    categoryId = cat.id;

    expect(await createLoan(appDb, admin, revolvingInput())).toEqual({ ok: true });
    [cardId] = (
      await db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Visa Oro"))
    ).map((r) => r.id);
    // A plain simple tracker, to prove the card payment path rejects it.
    expect(
      await createLoan(appDb, admin, {
        ...revolvingInput({ name: "Préstamo personal" }),
        amortizationMode: "",
        principal: "500.000,00",
        creditLimit: "",
        managementFee: "",
        statementDay: "",
      }),
    ).toEqual({ ok: true });
    [otherLoanId] = (
      await db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Préstamo personal"))
    ).map((r) => r.id);
  });

  afterAll(async () => {
    await client.close();
  });

  it("validates the revolving config at zod and service level", async () => {
    // Missing cupo: zod refine fires on the field.
    const noLimit = loanSchema.safeParse(revolvingInput({ creditLimit: "" }));
    expect(noLimit.success).toBe(false);
    // Rate on a revolving card: excluded (interest is manual).
    const withRate = loanSchema.safeParse(revolvingInput({ annualRate: "45" }));
    expect(withRate.success).toBe(false);
    // Revolving fields on a bank loan: excluded.
    const bankMixed = loanSchema.safeParse({
      ...revolvingInput({ amortizationMode: "bank", chargedRate: "12,95", fixedCuota: "1.000", termMonths: "12", cuotaDay: "5" }),
    });
    expect(bankMixed.success).toBe(false);
    // Bad statement day: typed service error on the field.
    expect(
      await createLoan(appDb, admin, revolvingInput({ name: "Mala", statementDay: "29" })),
    ).toEqual({ ok: false, error: "invalid_revolving_config", field: "statementDay" });
    // Bad fee: same shape.
    expect(
      await createLoan(appDb, admin, revolvingInput({ name: "Mala 2", managementFee: "-1" })),
    ).toEqual({ ok: false, error: "invalid_revolving_config", field: "managementFee" });
    // Members cannot manage cards.
    expect(await createLoan(appDb, member, revolvingInput({ name: "Mala 3" }))).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("starts a fresh card at zero debt with the full cupo available", async () => {
    const card = (await listLoans(appDb)).find((l) => l.id === cardId)!;
    expect(card).toMatchObject({
      amortizationMode: "revolving",
      principalCents: 0,
      creditLimitCents: 100_000_000,
      managementFeeCents: 5_000_000,
      statementDay: 25,
      purchasesCents: 0,
      outstandingCents: 0,
      availableCents: 100_000_000,
    });
  });

  it("counts purchases as debt: outstanding grows, cupo shrinks", async () => {
    await purchase(150_000, "2026-09-10");
    await purchase(250_000, "2026-09-12");
    // A pending quick-capture linked to the card is a placeholder, not debt.
    await db.insert(transactions).values({
      date: "2026-09-13",
      amountCents: 0,
      type: "expense",
      categoryId: null,
      memberId: payerId,
      paymentMethod: "card",
      cardLoanId: cardId,
      needsDetails: true,
      note: "Pendiente incluir detalles.",
    });

    const card = (await listLoans(appDb)).find((l) => l.id === cardId)!;
    expect(card.purchasesCents).toBe(400_000);
    expect(card.outstandingCents).toBe(400_000);
    expect(card.availableCents).toBe(99_600_000);
  });

  it("registers a card payment with manual interest and cuota de manejo", async () => {
    expect(
      await addCardPayment(appDb, member, cardId, cardPayment("700.000,00", {
        interest: "100.000,00",
        includeFee: "1",
      })),
    ).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, cardId));
    const paymentRow = rows.find((r) => r.kind === "payment")!;
    expect(paymentRow.amountCents).toBe(70_000_000);
    expect(paymentRow.memberId).toBe(payerId);
    const interestRow = rows.find((r) => r.kind === "interest")!;
    expect(interestRow.amountCents).toBe(10_000_000);
    expect(interestRow.note).toBe(CARD_INTEREST_NOTE);
    expect(interestRow.memberId).toBeNull();
    const feeRow = rows.find((r) => r.kind === "charge")!;
    expect(feeRow.amountCents).toBe(5_000_000);
    expect(feeRow.note).toBe(CARD_FEE_NOTE);

    // The capital mirrors the CASH outflow: total − interés − manejo
    // = 70.000.000 − 10.000.000 − 5.000.000. This payment is an OVERPAYMENT
    // (card debt was only 400.000) — the mirror formula is unchanged, the
    // cash left the household anyway. Linked to the payment row: CASCADE
    // keeps stats and ledger in lockstep.
    const capitalMirror = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, paymentRow.id));
    expect(capitalMirror).toHaveLength(1);
    expect(capitalMirror[0]).toMatchObject({
      amountCents: 55_000_000,
      type: "expense",
      categoryId: (
        await db.select({ id: categories.id }).from(categories).where(eq(categories.name, "Pago de tarjetas"))
      )[0].id,
      memberId: payerId,
      note: "Pago Visa Oro",
    });
    const interestMirror = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, interestRow.id));
    expect(interestMirror).toHaveLength(1);
    expect(interestMirror[0]).toMatchObject({
      amountCents: 10_000_000,
      categoryId: (
        await db.select({ id: categories.id }).from(categories).where(eq(categories.name, "Intereses de tarjetas"))
      )[0].id,
      memberId: payerId,
      note: "Interés Visa Oro",
    });
    const feeMirror = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, feeRow.id));
    expect(feeMirror).toHaveLength(1);

    // outstanding = purchases + interest + fee − total paid → saldo a favor
    // (paid beyond the debt); available clamps at the cupo, never above.
    const card = (await listLoans(appDb)).find((l) => l.id === cardId)!;
    expect(card.outstandingCents).toBe(400_000 + 10_000_000 + 5_000_000 - 70_000_000);
    expect(card.availableCents).toBe(100_000_000);
  });

  it("an all-finance payment mirrors NO capital row (nothing amortized)", async () => {
    // Total exactly = the included cuota de manejo → the amortizing portion
    // is zero: no 0-cent expense row, and no interest involved.
    expect(
      await addCardPayment(appDb, member, cardId, cardPayment("50.000,00", { includeFee: "1" })),
    ).toEqual({ ok: true });
    const [paymentRow] = await db
      .select()
      .from(loanPayments)
      .where(
        and(
          eq(loanPayments.loanId, cardId),
          eq(loanPayments.kind, "payment"),
          eq(loanPayments.amountCents, 5_000_000),
        ),
      )
      .limit(1);
    expect(paymentRow.kind).toBe("payment");
    const capitalMirrors = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, paymentRow.id));
    expect(capitalMirrors).toHaveLength(0);
  });

  it("an all-finance payment needs NO Pago de tarjetas category (R3-001)", async () => {
    // Hide the system category by RENAMING it (the id stays, so the FKs of
    // earlier mirrors stay intact): with nothing amortized, the payment must
    // not require the capital mirror category to exist.
    await db
      .update(categories)
      .set({ name: "Pago de tarjetas (oculta)" })
      .where(eq(categories.name, "Pago de tarjetas"));
    try {
      expect(
        await addCardPayment(appDb, member, cardId, cardPayment("50.000,00", { includeFee: "1" })),
      ).toEqual({ ok: true });
    } finally {
      await db
        .update(categories)
        .set({ name: "Pago de tarjetas" })
        .where(eq(categories.name, "Pago de tarjetas (oculta)"));
    }
  });

  it("rejects card payments with typed errors", async () => {
    expect(
      await addCardPayment(appDb, member, otherLoanId, cardPayment("1.000,00")),
    ).toEqual({ ok: false, error: "loan_not_revolving" });
    expect(
      await addCardPayment(appDb, member, cardId, cardPayment("1.000,00", { interest: "abc" })),
    ).toEqual({ ok: false, error: "invalid_interest" });
    expect(
      await addCardPayment(appDb, member, cardId, cardPayment("1.000,00", { interest: "0" })),
    ).toEqual({ ok: false, error: "invalid_interest" });
  });

  it("suffixed same-day interest rows instead of a raw unique violation", async () => {
    await addCardPayment(appDb, member, cardId, cardPayment("10.000,00", { interest: "1.000,00" }));
    await addCardPayment(appDb, member, cardId, cardPayment("10.000,00", { interest: "2.000,00" }));
    const interestRows = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, cardId));
    const notes = interestRows.filter((r) => r.kind === "interest").map((r) => r.note);
    expect(notes).toContain(CARD_INTEREST_NOTE);
    expect(notes).toContain(`${CARD_INTEREST_NOTE} (2)`);
  });

  it("lets an admin correct wrong ledger rows; mirrors fall by CASCADE", async () => {
    const [wrong] = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.note, `${CARD_INTEREST_NOTE} (2)`));
    // Member: forbidden.
    expect(await removeLedgerEntry(appDb, member, wrong.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    // The wrong row's mirror exists before the correction…
    const [mirror] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, wrong.id));
    expect(mirror).toBeDefined();
    expect(await removeLedgerEntry(appDb, admin, wrong.id)).toEqual({ ok: true });
    // …and falls with it.
    const [gone] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.loanPaymentId, wrong.id));
    expect(gone).toBeUndefined();
    expect(await removeLedgerEntry(appDb, admin, wrong.id)).toEqual({
      ok: false,
      error: "entry_not_found",
    });
  });

  it("never auto-accrues interest on a revolving card", async () => {
    await catchUpAllLoanInterest(appDb);
    const engineInterest = await db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, cardId));
    // Only the MANUAL rows survive — the catch-up added nothing.
    expect(engineInterest.filter((r) => r.kind === "interest").length).toBe(2);
  });

  it("true-ups the card balance INCLUDING purchases", async () => {
    // Stated absolute balance (positive: the true-up valve takes balances,
    // not signed a-favor states). If updateOutstanding ignored purchases
    // while listLoans counts them, the convergence below would diverge.
    const stated = 1_234_567;
    expect(
      await updateOutstanding(appDb, admin, cardId, (stated / 100).toFixed(2).replace(".", ",")),
    ).toEqual({ ok: true });
    const after = (await listLoans(appDb)).find((l) => l.id === cardId)!;
    expect(after.outstandingCents).toBe(stated);
  });

  it("groups the card history into billing cycles by statement day", async () => {
    // Purchases already seeded: 09-10 and 09-12 (anchor 09-25, closed) plus
    // one more after the cut → the trailing open cycle (anchor 10-25).
    await purchase(90_000, "2026-09-28");
    // Fixed clock (same pattern as the accrual tests): the closed/open split
    // compares against `now`, so the assertions must never depend on the
    // wall-clock date the suite happens to run on.
    const cycles = await listCardCycles(appDb, cardId, new Date("2026-09-26T12:00:00Z"));
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    const [open, closed] = cycles;
    expect(closed.closed).toBe(true);
    expect(closed.endDate).toBe("2026-09-25");
    expect(closed.purchasesCents).toBe(400_000);
    expect(open.endDate).toBe("2026-10-25");
    expect(open.closed).toBe(false);
    expect(open.purchasesCents).toBe(90_000);
    // Non-revolving / unconfigured cards group nothing.
    expect(await listCardCycles(appDb, otherLoanId)).toEqual([]);
  });
});
