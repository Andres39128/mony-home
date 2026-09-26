import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
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
  listLoanPeriods,
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
import { transactionTotals } from "@/features/transactions/service";
import { todayIso } from "@/lib/date";
import type { SessionUser } from "@/lib/auth";
import { catchUpBankInterest } from "@/features/loans/accrual";
import { allocateWaterfall } from "@/features/loans/amortization";

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

/** Golden Davivienda statement constants (R2 Spec Amendment):
 *  saldo0 = $204.993.414,80, EA cobrada 1295 bp, cuota $2.628.000,00,
 *  33-day interest line; per-millón rates BACK-COMPUTED so the saldo-based
 *  vida = $96.617,00 and the property-based incendio = $74.136,00 exactly. */
const GOLDEN = {
  saldo0Cents: 20_499_341_480,
  propertyCents: 33_980_260_000,
  chargedRateBp: 1295,
  cuotaCents: 262_800_000,
  days: 33,
  // Back-computed integers (round(target × 1e11 / base)); engine-exact by
  // construction: round(saldo0/1e6 × 47.131.758/1e5) = 9.661.700 etc.
  lifeRateX100k: 47_131_758,
  fireRateX100k: 21_817_373,
  vidaCents: 9_661_700,
  incendioCents: 7_413_600,
  interest33Cents: 226_940_638, // engine day-by-day compounded sum (ground truth)
  bankStatedInterestCents: 208_346_634, // $2.083.466,34 statement line
} as const;

interface GoldenOverrides {
  name?: string;
  principalCents?: number;
  lifeX100k?: number;
  fireX100k?: number;
  otrosCents?: number;
  propertyCents?: number;
  moraRateBp?: number;
}

/** Bank-mode loan at golden scale, created 2026-01-10, cuota closing day 25. */
async function seedGoldenBankLoan(
  db: PgliteDatabase,
  overrides: GoldenOverrides = {},
): Promise<string> {
  const [loan] = await db
    .insert(loans)
    .values({
      name: overrides.name ?? "Golden Davivienda",
      kind: "mortgage",
      entity: "Davivienda",
      scope: "common",
      principalCents: overrides.principalCents ?? GOLDEN.saldo0Cents,
      amortizationMode: "bank",
      chargedRateBp: GOLDEN.chargedRateBp,
      contractualRateBp: 1747,
      termMonths: 228,
      fixedCuotaCents: GOLDEN.cuotaCents,
      cuotaDay: 25,
      lifeInsuranceRatePerMillonX100k: overrides.lifeX100k ?? null,
      fireInsuranceRatePerMillonX100k: overrides.fireX100k ?? null,
      otherChargesCents: overrides.otrosCents ?? null,
      propertyValueCents: overrides.propertyCents ?? null,
      moraRateBp: overrides.moraRateBp ?? null,
      createdAt: new Date("2026-01-10T12:00:00Z"),
    })
    .returning();
  return loan.id;
}

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
    const loanId = await seedGoldenBankLoan(db, { name: "Dorada 33" });
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
    expect(sum).toBe(GOLDEN.interest33Cents);

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
      GOLDEN.interest33Cents,
    );
    expect(vida + incendio + GOLDEN.interest33Cents + capitalCents).toBe(GOLDEN.cuotaCents);
    expect(capitalCents).toBe(18_784_062); // $187.840,62 — the golden residual
    expect(capitalCents).toBe(
      GOLDEN.cuotaCents - (vida + incendio + GOLDEN.interest33Cents),
    );

    // Bank delta (R2 amendment #4): recorded in the output, NOT asserted
    // equal — the drift is absorbed operationally by the true-up.
    const delta = {
      engineInterestCents: GOLDEN.interest33Cents,
      bankStatedInterestCents: GOLDEN.bankStatedInterestCents,
      deltaCents: GOLDEN.interest33Cents - GOLDEN.bankStatedInterestCents,
    };
    console.info("[golden] engine vs bank statement interest line:", delta);
    expect(delta.deltaCents).toBe(GOLDEN.interest33Cents - GOLDEN.bankStatedInterestCents);
  });

  it("listLoanPeriods renders the 5 sections and the saldo identity EXACTLY (golden period 1)", async () => {
    const loanId = await seedGoldenBankLoan(db, {
      name: "Dorada período",
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
    const loanId = await seedGoldenBankLoan(db, { name: "Dorada abierta" });
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
