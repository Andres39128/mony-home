import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loanPayments, loans, users } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { catchUpAllLoanInterest, catchUpBankInterest, catchUpInterest } from "@/features/loans/accrual";
import { getDebtCents, listLoans, updateOutstanding } from "@/features/loans/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Accrual engine suite: deterministic fixtures with injectable `now`.
 * Exact-cent monthly charges on the DECLINING balance:
 *   charge = round(outstanding_before × bp / 12 / 10000)
 * per elapsed whole month, dated the month start. Payments made mid-month
 * only reduce the NEXT month's charge.
 *
 * The bank-engine block below covers amortization_mode='bank': daily EA
 * compound rows over the running saldo, note-keyed component charges at
 * each cuota_day close, mora on unpaid closed-cuota lines, and the mode
 * fan-out that keeps simple loans on the untouched monthly engine.
 */

/** Loan created 2026-08-15 at 12% TNA, $1.000 principal, $500 paid on 2026-08-20. */
async function seedDecliningFixture(
  db: PgliteDatabase,
  payerId: string,
  name = "Declinante",
): Promise<string> {
  const [loan] = await db
    .insert(loans)
    .values({
      name,
      kind: "credit_card",
      entity: "Banco",
      scope: "common",
      principalCents: 100_000,
      annualRateBp: 1200,
      createdAt: new Date("2026-08-15T12:00:00Z"),
    })
    .returning();
  await db.insert(loanPayments).values({
    loanId: loan.id,
    memberId: payerId,
    kind: "payment",
    amountCents: 50_000,
    date: "2026-08-20",
  });
  return loan.id;
}

async function ledgerRows(db: PgliteDatabase, loanId: string) {
  return db
    .select()
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(asc(loanPayments.date));
}

describe("catchUpInterest (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let payerId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [user] = await db
      .insert(users)
      .values({ username: "payer", passwordHash: "x", name: "Payer" })
      .returning();
    payerId = user.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("accrues 3 elapsed months on the DECLINING balance with exact cents", async () => {
    const loanId = await seedDecliningFixture(db, payerId);

    const inserted = await catchUpInterest(appDb, loanId, new Date("2026-11-05T10:00:00Z"));
    expect(inserted).toBe(3);

    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-09-01", 500], // 50000 × 1% — the Aug 20 payment reduced the base
      ["2026-10-01", 505], // 50500 × 1%
      ["2026-11-01", 510], // 51005 × 1% → 510.05 rounds to 510
    ]);
    expect(rows.every((r) => r.memberId === null)).toBe(true);
    expect(rows[0].note).toBe("Interés 12% TNA");
  });

  it("treats 21:30 ART on the last day of a month as the OLD app-TZ month", async () => {
    const loanId = await seedDecliningFixture(db, payerId, "Borde de mes");

    // 2026-09-30 21:30 ART == 2026-10-01T00:30:00Z. On a UTC server the old
    // server-local getMonth() already saw October and rolled the loan month
    // early; the app-TZ helper must still count this instant as September.
    const boundaryUtc = new Date("2026-10-01T00:30:00Z");
    expect(await catchUpInterest(appDb, loanId, boundaryUtc)).toBe(1);
    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([["2026-09-01", 500]]);

    // Crossing midnight ART (00:30 Oct 1) is what actually opens October.
    const afterBoundary = new Date("2026-10-01T03:30:00Z");
    expect(await catchUpInterest(appDb, loanId, afterBoundary)).toBe(1);
    const all = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(all.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-09-01", 500],
      ["2026-10-01", 505], // 50500 × 1% — October charge includes September's interest
    ]);
  });

  it("is idempotent: re-running with the same now inserts nothing", async () => {
    const loanId = await seedDecliningFixture(db, payerId, "Idempotente");
    const now = new Date("2026-11-05T10:00:00Z");
    await catchUpInterest(appDb, loanId, now);

    const second = await catchUpInterest(appDb, loanId, now);
    expect(second).toBe(0);
    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(3);
  });

  it("no-ops on partial months, same month, unknown loans, rateless and overpaid loans", async () => {
    const loanId = await seedDecliningFixture(db, payerId, "Parcial");

    // Same month as creation → zero elapsed whole months.
    expect(await catchUpInterest(appDb, loanId, new Date("2026-08-31T23:00:00Z"))).toBe(0);

    // Rateless loan: quiet no-op.
    const [plain] = await db
      .insert(loans)
      .values({ name: "Sin tasa", kind: "mortgage", entity: "Banco", scope: "common", principalCents: 1 })
      .returning();
    expect(await catchUpInterest(appDb, plain.id, new Date("2026-11-05"))).toBe(0);

    // Zero-rate loan: charge rounds to 0 → no rows.
    const [zeroRate] = await db
      .insert(loans)
      .values({
        name: "Tasa cero",
        kind: "other",
        entity: "Banco",
        scope: "common",
        principalCents: 1_000_000,
        annualRateBp: 0,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      })
      .returning();
    expect(await catchUpInterest(appDb, zeroRate.id, new Date("2026-08-01T00:00:00Z"))).toBe(0);
    expect(await ledgerRows(db, zeroRate.id)).toHaveLength(0);

    // Overpaid loan: outstanding ≤ 0 → no negative "interest" refunds.
    const [overpaid] = await db
      .insert(loans)
      .values({
        name: "Sobrepagado",
        kind: "other",
        entity: "Banco",
        scope: "common",
        principalCents: 10_000,
        annualRateBp: 1200,
        // Mid-month noon creation: the first accrual month start is June 1.
        createdAt: new Date("2026-05-20T15:00:00Z"),
      })
      .returning();
    await db.insert(loanPayments).values({
      loanId: overpaid.id,
      memberId: payerId,
      kind: "payment",
      amountCents: 20_000,
      date: "2026-05-25",
    });
    expect(await catchUpInterest(appDb, overpaid.id, new Date("2026-08-01T00:00:00Z"))).toBe(0);
    expect(await ledgerRows(db, overpaid.id)).toHaveLength(1); // the payment only

    // Ghost id: quiet no-op.
    expect(
      await catchUpInterest(appDb, "00000000-0000-4000-8000-000000000000", new Date("2026-11-05")),
    ).toBe(0);
  });

  it("charges the FULL balance for the month a payment lands in; the next month declines", async () => {
    const [loan] = await db
      .insert(loans)
      .values({
        name: "Mitad de mes",
        kind: "other",
        entity: "Banco",
        scope: "common",
        principalCents: 100_000,
        annualRateBp: 1200,
        createdAt: new Date("2026-08-15T12:00:00Z"),
      })
      .returning();
    // Payment on Sep 15: does NOT reduce Sep's charge (dated after Sep 1).
    await db.insert(loanPayments).values({
      loanId: loan.id,
      memberId: payerId,
      kind: "payment",
      amountCents: 90_000,
      date: "2026-09-15",
    });

    const inserted = await catchUpInterest(appDb, loan.id, new Date("2026-10-05T00:00:00Z"));
    expect(inserted).toBe(2);
    const rows = (await ledgerRows(db, loan.id)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-09-01", 1000], // 100000 × 1% — payment lands later that month
      ["2026-10-01", 110], // 11000 × 1% — declined balance
    ]);
  });

  it("runs lazily from read paths: listLoans and getDebtCents trigger catch-up", async () => {
    await seedDecliningFixture(db, payerId, "Lectura");

    // No catchUpInterest call here — the read path must do it.
    const loanRows = await listLoans(appDb);
    const loan = loanRows.find((l) => l.name === "Lectura")!;
    const rows = await ledgerRows(db, loan.id);
    const interest = rows.filter((r) => r.kind === "interest");
    expect(interest.length).toBeGreaterThan(0);
    expect(loan.interestCents).toBe(interest.reduce((sum, r) => sum + r.amountCents, 0));
    expect(loan.outstandingCents).toBe(
      loan.principalCents + loan.interestCents - loan.paidCents,
    );

    const debt = await getDebtCents(appDb);
    expect(debt).toBeGreaterThan(0);
  });

  it("rebases accrual after an admin balance true-up", async () => {
    const [admin] = await db
      .insert(users)
      .values({ username: "accrual-admin", passwordHash: "x", name: "A", role: "admin" })
      .returning();
    const user: SessionUser = {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      role: admin.role,
    };

    const [loan] = await db
      .insert(loans)
      .values({
        name: "Rebazada",
        kind: "other",
        entity: "Banco",
        scope: "common",
        principalCents: 20_000,
        annualRateBp: 1200,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();

    // Statement says $1.000: +80000 as ONE "Ajuste de saldo" row.
    expect(await updateOutstanding(appDb, user, loan.id, "1.000,00")).toEqual({ ok: true });
    let rows = await ledgerRows(db, loan.id);
    const ajuste = rows.find((r) => r.note === "Ajuste de saldo")!;
    expect(ajuste).toMatchObject({ kind: "interest", memberId: null, amountCents: 80_000 });

    // Next months accrue on the rebased (HIGHER) balance.
    await catchUpInterest(appDb, loan.id, new Date("2026-11-18T00:00:00Z"));
    rows = await ledgerRows(db, loan.id);
    const monthly = rows.filter((r) => r.note === "Interés 12% TNA");
    expect(monthly.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-10-01", 1000], // 100000 × 1%
      ["2026-11-01", 1010], // 101000 × 1%
    ]);

    // Paying down after a true-up declines from the rebased balance.
    await db.insert(loanPayments).values({
      loanId: loan.id,
      memberId: user.id,
      kind: "payment",
      amountCents: 50_000,
      date: "2026-11-20",
    });
    await catchUpInterest(appDb, loan.id, new Date("2026-12-18T00:00:00Z"));
    rows = await ledgerRows(db, loan.id);
    const monthlyAfter = rows.filter((r) => r.note === "Interés 12% TNA");
    expect(monthlyAfter.at(-1)).toMatchObject({ date: "2026-12-01", amountCents: 520 }); // 52010 × 1%
  });
});

interface BankOverrides {
  name?: string;
  principalCents?: number;
  lifeX100k?: number;
  fireX100k?: number;
  otrosCents?: number;
  propertyCents?: number;
  moraRateBp?: number;
  createdAt?: Date;
}

/**
 * Bank-mode loan fixture: $1.000.000 principal at 12.95% EA, cuota closing
 * day 25, created 2026-01-10 (accrual base day = creation day; first daily
 * row is 2026-01-11). Insurance components default to OFF (null = off).
 */
async function seedBankLoan(db: PgliteDatabase, overrides: BankOverrides = {}): Promise<string> {
  const [loan] = await db
    .insert(loans)
    .values({
      name: overrides.name ?? "Hipoteca banca",
      kind: "mortgage",
      entity: "Davivienda",
      scope: "common",
      principalCents: overrides.principalCents ?? 100_000_000,
      amortizationMode: "bank",
      chargedRateBp: 1295,
      contractualRateBp: 1747,
      termMonths: 228,
      fixedCuotaCents: 262_800_000,
      cuotaDay: 25,
      lifeInsuranceRatePerMillonX100k: overrides.lifeX100k,
      fireInsuranceRatePerMillonX100k: overrides.fireX100k,
      otherChargesCents: overrides.otrosCents,
      propertyValueCents: overrides.propertyCents,
      moraRateBp: overrides.moraRateBp,
      createdAt: overrides.createdAt ?? new Date("2026-01-10T12:00:00Z"),
    })
    .returning();
  return loan.id;
}

describe("catchUpBankInterest — daily bank engine (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let payerId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [user] = await db
      .insert(users)
      .values({ username: "bank-payer", passwordHash: "x", name: "Bank Payer" })
      .returning();
    payerId = user.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("accrues one rounded daily row per elapsed day over the RUNNING saldo", async () => {
    const loanId = await seedBankLoan(db, { name: "Diaria" });

    const inserted = await catchUpBankInterest(appDb, loanId, new Date("2026-01-14T12:00:00Z"));
    expect(inserted).toBe(3);

    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    // Ground truth: round(saldo × ((1.1295)^(1/365) − 1)); interest joins the
    // saldo, so day 2 compounds on 100_033_369 → 33380, day 3 on 100_066_749.
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-01-11", 33369],
      ["2026-01-12", 33380],
      ["2026-01-13", 33391],
    ]);
    expect(rows.every((r) => r.memberId === null)).toBe(true);
    expect(rows.every((r) => r.note === "Interés diario")).toBe(true); // rate-agnostic constant note
  });

  it("materializes exactly 33 daily rows for a 33-day period — including at golden scale", async () => {
    const loanId = await seedBankLoan(db, { name: "Treinta y tres" });
    await catchUpBankInterest(appDb, loanId, new Date("2026-02-13T12:00:00Z")); // yesterday 02-12

    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(33); // 2026-01-11 .. 2026-02-12
    expect(rows[0]).toMatchObject({ date: "2026-01-11", amountCents: 33369 });
    expect(rows.at(-1)).toMatchObject({ date: "2026-02-12", amountCents: 33727 });
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(1_107_064);
    // No components configured → the cuota_day crossing stays bookkeeping-only.
    expect((await ledgerRows(db, loanId)).filter((r) => r.kind === "charge")).toHaveLength(0);

    // Davivienda statement scale: saldo0 $204.993.414,80 at 12,95% EA, 33 days.
    const goldenId = await seedBankLoan(db, {
      name: "Escala dorada",
      principalCents: 20_499_341_480,
    });
    await catchUpBankInterest(appDb, goldenId, new Date("2026-02-13T12:00:00Z"));
    const golden = (await ledgerRows(db, goldenId)).filter((r) => r.kind === "interest");
    expect(golden).toHaveLength(33);
    expect(golden[0].amountCents).toBe(6_840_342); // slice-2 ground truth on saldo0
    expect(golden.at(-1)!.amountCents).toBe(6_913_762); // compounded running saldo
    expect(golden.reduce((sum, r) => sum + r.amountCents, 0)).toBe(226_940_638);
  });

  it("is idempotent: a second read with the same now inserts nothing; a later now only extends", async () => {
    const loanId = await seedBankLoan(db, { name: "Idempotente banca" });
    const now = new Date("2026-01-14T12:00:00Z");
    expect(await catchUpBankInterest(appDb, loanId, now)).toBe(3);

    expect(await catchUpBankInterest(appDb, loanId, now)).toBe(0);
    let rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(3);

    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-01-16T12:00:00Z"))).toBe(2);
    rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-01-11", 33369],
      ["2026-01-12", 33380],
      ["2026-01-13", 33391],
      ["2026-01-14", 33402],
      ["2026-01-15", 33413],
    ]);
  });

  it("a mid-period payment reduces the saldo for later days only (earns from the day AFTER)", async () => {
    const loanId = await seedBankLoan(db, { name: "Pago intermedio" });
    await db.insert(loanPayments).values({
      loanId,
      memberId: payerId,
      kind: "payment",
      amountCents: 40_000_000,
      date: "2026-01-20",
    });

    await catchUpBankInterest(appDb, loanId, new Date("2026-01-25T12:00:00Z"));
    const rows = (await ledgerRows(db, loanId))
      .filter((r) => r.kind === "interest")
      .map((r) => [r.date, r.amountCents] as const);
    expect(rows).toHaveLength(14); // 2026-01-11 .. 2026-01-24
    // Jan 20 still accrues on the unreduced saldo; Jan 21 drops to the
    // ~$601.670 post-payment saldo and resumes compounding from there.
    expect(rows.slice(9)).toEqual([
      ["2026-01-20", 33469],
      ["2026-01-21", 20133],
      ["2026-01-22", 20139],
      ["2026-01-23", 20146],
      ["2026-01-24", 20153],
    ]);
  });

  it("materializes one charge row per component at the cuota_day close, exact per-millón cents", async () => {
    const loanId = await seedBankLoan(db, {
      name: "Cargos",
      lifeX100k: 46_790_000, // 467,90/millón
      fireX100k: 18_330_000, // 183,30/millón
      otrosCents: 1_234_567,
      propertyCents: 33_980_260_000, // $339.802.600,00
    });

    await catchUpBankInterest(appDb, loanId, new Date("2026-02-05T12:00:00Z"));
    const rows = await ledgerRows(db, loanId);

    // ONE row per configured component, dated the anchor (Jan 25):
    //   vida   = round(100_000_000/1e6 × 46_790_000/1e5) = round(100 × 467,90)      = 46_790
    //   incen. = round(33_980_260_000/1e6 × 18_330_000/1e5) = round(33980,26 × 183,30) = 6_228_582
    //   otros  = fixed other_charges_cents
    const charges = rows.filter((r) => r.kind === "charge");
    expect(charges.map((r) => [r.date, r.note, r.amountCents])).toEqual([
      ["2026-01-25", "Seguro de vida", 46_790],
      ["2026-01-25", "Seguro de incendio", 6_228_582],
      ["2026-01-25", "Otros cargos", 1_234_567],
    ]);
    expect(charges.every((r) => r.memberId === null)).toBe(true);

    // Vida is keyed to the period-START saldo (the running saldo when the
    // period opened), never insured_base_cents — and the charges join the
    // saldo AFTER the close, so Jan 26's interest jumps over them.
    const interest = rows.filter((r) => r.kind === "interest");
    expect(interest).toHaveLength(25); // 2026-01-11 .. 2026-02-04
    expect(interest.map((r) => [r.date, r.amountCents]).slice(13, 16)).toEqual([
      ["2026-01-24", 33514],
      ["2026-01-25", 33525], // anchor day accrues inside the closing period
      ["2026-01-26", 36042], // over saldo + vida + incendio + otros
    ]);
  });

  it("charges recur every period: vida tracks the balance, incendio stays on the property value", async () => {
    const loanId = await seedBankLoan(db, {
      name: "Recurrentes",
      lifeX100k: 46_790_000,
      fireX100k: 18_330_000,
      otrosCents: 1_234_567,
      propertyCents: 33_980_260_000,
    });

    await catchUpBankInterest(appDb, loanId, new Date("2026-03-05T12:00:00Z")); // anchors Jan 25 + Feb 25
    const charges = (await ledgerRows(db, loanId)).filter((r) => r.kind === "charge");

    expect(charges.filter((r) => r.note === "Seguro de vida").map((r) => [r.date, r.amountCents])).toEqual([
      // period 1 opened at saldo 100_000_000; period 2 at 108_011_639
      // (100M + Jan interest + Jan charges) → 50_539 = round(108,011639 × 467,90).
      ["2026-01-25", 46_790],
      ["2026-02-25", 50_539],
    ]);
    expect(
      charges.filter((r) => r.note === "Seguro de incendio").map((r) => [r.date, r.amountCents]),
    ).toEqual([
      ["2026-01-25", 6_228_582],
      ["2026-02-25", 6_228_582], // property value is constant
    ]);
    expect(charges.filter((r) => r.note === "Otros cargos").map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-01-25", 1_234_567],
      ["2026-02-25", 1_234_567],
    ]);
  });

  it("mora accrues daily while the closed cuota is unpaid past the anchor and stops once paid", async () => {
    const loanId = await seedBankLoan(db, { name: "Morosa", moraRateBp: 3650 });

    // Phase 1: Jan 25 closes a cuota whose lines (15 daily rows, 11–25 Jan)
    // total 501_700 — nobody pays → mora = round(501_700 × 0,365/365) = 502/day.
    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-02-10T12:00:00Z"))).toBe(45);
    let rows = await ledgerRows(db, loanId);
    const mora = rows.filter((r) => r.note === "Mora");
    expect(mora.map((r) => [r.date, r.amountCents])).toEqual(
      // entry strictly past the anchor: 2026-01-26 .. 2026-02-09
      Array.from({ length: 15 }, (_, i) => [
        i < 6 ? `2026-01-${26 + i}` : `2026-02-0${i - 5}`,
        502,
      ]),
    );
    expect(mora.every((r) => r.kind === "charge" && r.memberId === null)).toBe(true);
    expect(rows.filter((r) => r.kind === "interest")).toHaveLength(30); // Jan 11 .. Feb 9

    // Phase 2: pay exactly the overdue base on Feb 3 — mora STOPS accruing
    // (no rows dated after Feb 9); the rows phase 1 already materialized are
    // immutable ledger history, like every engine row.
    await db.insert(loanPayments).values({
      loanId,
      memberId: payerId,
      kind: "payment",
      amountCents: 501_700,
      date: "2026-02-03",
    });
    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-02-20T12:00:00Z"))).toBe(10);
    rows = await ledgerRows(db, loanId);
    const moraAfter = rows.filter((r) => r.note === "Mora");
    expect(moraAfter).toHaveLength(15); // still Jan 26 .. Feb 9 — none new
    expect(moraAfter.at(-1)).toMatchObject({ date: "2026-02-09", amountCents: 502 });
    const interest = rows.filter((r) => r.kind === "interest").map((r) => [r.date, r.amountCents] as const);
    expect(interest).toHaveLength(40); // Jan 11 .. Feb 19
    expect(interest[30]).toEqual(["2026-02-10", 33539]); // compounding over the
    expect(interest[39]).toEqual(["2026-02-19", 33640]); // mora-augmented saldo
  });

  it("rate edits are prospective: existing rows stay byte-identical, new days use the new factor", async () => {
    const loanId = await seedBankLoan(db, { name: "Retasada" });
    await catchUpBankInterest(appDb, loanId, new Date("2026-01-15T12:00:00Z"));
    const before = (await ledgerRows(db, loanId))
      .filter((r) => r.kind === "interest")
      .map((r) => ({ date: r.date, amountCents: r.amountCents, note: r.note }));
    expect(before.map((r) => r.amountCents)).toEqual([33369, 33380, 33391, 33402]);

    await db.update(loans).set({ chargedRateBp: 2400 }).where(eq(loans.id, loanId));

    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-01-18T12:00:00Z"))).toBe(3);
    const after = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(after).toHaveLength(7);
    // Old rows immutable: same dates, cents and (rate-agnostic) note.
    expect(after.slice(0, 4).map((r) => ({ date: r.date, amountCents: r.amountCents, note: r.note }))).toEqual(
      before,
    );
    // New days compound at 24% EA over the saldo carried from the old rows.
    expect(after.slice(4).map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-01-15", 59031], // round(100_133_542 × (1,24^(1/365) − 1))
      ["2026-01-16", 59066],
      ["2026-01-17", 59100],
    ]);
    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-01-18T12:00:00Z"))).toBe(0);
  });

  it("leap year: February 2028 accrues 29 daily rows and the divisor stays 365", async () => {
    const loanId = await seedBankLoan(db, {
      name: "Bisiesta",
      createdAt: new Date("2028-01-20T12:00:00Z"),
    });

    await catchUpBankInterest(appDb, loanId, new Date("2028-03-01T12:00:00Z")); // yesterday 02-29
    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(40); // Jan 21 .. Feb 29
    const february = rows.filter((r) => r.date.startsWith("2028-02"));
    expect(february).toHaveLength(29); // Feb 29 accrues like any other day
    expect(february[0]).toMatchObject({ date: "2028-02-01", amountCents: 33491 });
    // Feb 29 runs on saldo 101_309_661: the /365 factor gives 33_806; a /366
    // divisor would give 33_713 — the discriminator pins the constant 365.
    expect(february.at(-1)).toMatchObject({ date: "2028-02-29", amountCents: 33806 });
  });

  it("fan-out: simple-mode loans keep the monthly engine untouched; bank loans go daily (no double-charge)", async () => {
    // Simple loan, same fixture as the monthly suite: 3 months → 500/505/510.
    const [simple] = await db
      .insert(loans)
      .values({
        name: "Simple intacta",
        kind: "credit_card",
        entity: "Banco",
        scope: "common",
        principalCents: 100_000,
        annualRateBp: 1200,
        createdAt: new Date("2026-08-15T12:00:00Z"),
      })
      .returning();
    await db.insert(loanPayments).values({
      loanId: simple.id,
      memberId: payerId,
      kind: "payment",
      amountCents: 50_000,
      date: "2026-08-20",
    });
    const bankId = await seedBankLoan(db, { name: "Banca fan-out" });

    await catchUpAllLoanInterest(appDb, new Date("2026-11-05T12:00:00Z"));

    const simpleRows = await ledgerRows(db, simple.id);
    const simpleInterest = simpleRows.filter((r) => r.kind === "interest");
    expect(simpleInterest.map((r) => [r.date, r.amountCents, r.note])).toEqual([
      ["2026-09-01", 500, "Interés 12% TNA"], // exactly the monthly engine's cents
      ["2026-10-01", 505, "Interés 12% TNA"],
      ["2026-11-01", 510, "Interés 12% TNA"],
    ]);
    expect(simpleRows.filter((r) => r.note === "Interés diario")).toHaveLength(0);

    const bankRows = await ledgerRows(db, bankId);
    const bankInterest = bankRows.filter((r) => r.kind === "interest");
    expect(bankInterest).toHaveLength(298); // 2026-01-11 .. 2026-11-04, daily
    expect(bankInterest.every((r) => r.note === "Interés diario")).toBe(true);
    expect(bankInterest.at(-1)).toMatchObject({ date: "2026-11-04" });
    expect(bankRows.filter((r) => r.note === "Interés 12% TNA")).toHaveLength(0);
  });

  it("recovers from a 23505 on the batch insert: savepoint replay keeps the racing writer's row", async () => {
    const loanId = await seedBankLoan(db, { name: "Carrera banca" });

    // A pre-inserted duplicate can't exist in the pending window (any
    // interest row advances the accrual base past itself), so the racing
    // writer is simulated where it actually races: while the engine's
    // transaction is mid-flight. PGlite is single-session, so the closest
    // faithful simulation of a bypassed-lock writer is landing the duplicate
    // inside the engine's transaction but OUTSIDE the batch savepoint —
    // exactly where a committed cross-connection writer sits when the batch
    // collides with it. (Firing at the insert statement itself would place
    // the row INSIDE the savepoint, and the 23505 rollback would silently
    // undo it — a vacuous race the assertions could not detect.)
    const realTransaction = client.transaction.bind(client);
    (client as unknown as Record<string, unknown>).transaction = (
      cb: (tx: unknown) => unknown,
    ) =>
      realTransaction(async (pgTx) => {
        const rawQuery = (pgTx as { query: (...args: unknown[]) => Promise<unknown> }).query.bind(
          pgTx,
        );
        let raced = false;
        (pgTx as unknown as Record<string, unknown>).query = async (
          sql: unknown,
          ...rest: unknown[]
        ) => {
          const text = typeof sql === "string" ? sql : "";
          if (!raced && text.startsWith("savepoint")) {
            raced = true;
            // The bypassing writer covers 2026-01-13 with a sentinel amount
            // while the engine is mid-flight.
            await rawQuery(
              'insert into "loan_payments" ("loan_id", "member_id", "kind", "amount_cents", "date", "note") values ($1, $2, $3, $4, $5, $6)',
              [loanId, null, "interest", 999_999, "2026-01-13", "Interés diario"],
            );
          }
          return rawQuery(sql, ...rest);
        };
        return cb(pgTx);
      });

    try {
      await catchUpBankInterest(appDb, loanId, new Date("2026-01-14T12:00:00Z"));
    } finally {
      (client as unknown as Record<string, unknown>).transaction = realTransaction;
    }

    // The savepoint keeps the outer transaction usable; the replay lands
    // 01-11 and 01-12 while the racer's 01-13 row is kept untouched.
    const rows = (await ledgerRows(db, loanId)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-01-11", 33369],
      ["2026-01-12", 33380],
      ["2026-01-13", 999_999],
    ]);

    expect(await catchUpBankInterest(appDb, loanId, new Date("2026-01-14T12:00:00Z"))).toBe(0);
    expect((await ledgerRows(db, loanId)).filter((r) => r.kind === "interest")).toHaveLength(3);
  });
});
