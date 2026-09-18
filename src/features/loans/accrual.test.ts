import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { loanPayments, loans, users } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { catchUpInterest } from "@/features/loans/accrual";
import { getDebtCents, listLoans, updateOutstanding } from "@/features/loans/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Accrual engine suite: deterministic fixtures with injectable `now`.
 * Exact-cent monthly charges on the DECLINING balance:
 *   charge = round(outstanding_before × bp / 12 / 10000)
 * per elapsed whole month, dated the month start. Payments made mid-month
 * only reduce the NEXT month's charge.
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
    expect(await updateOutstanding(appDb, user, loan.id, "1.000")).toEqual({ ok: true });
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
