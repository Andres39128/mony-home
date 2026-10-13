import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { auditLog, categories, loans, savingsGoals, users } from "@/db/schema";
import {
  AUDIT_ENTITIES,
  auditAmount,
  listAudits,
  recordAudit,
} from "@/features/audit/service";
import { createTransaction, movementSchema } from "@/features/transactions/service";
import { addLoanPayment, createLoan } from "@/features/loans/service";
import { addContribution, createGoal } from "@/features/savings/service";
import { setForMonth } from "@/features/budgets/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Audit trail suite (F9): recordAudit's insert shape and best-effort
 * delivery contract, plus representative END-TO-END wiring asserts — a
 * service-layer mutation lands exactly one audit row (transaction create,
 * loan payment, goal contribution, budget set). The remaining ~25 call
 * sites follow the same one-line pattern; asserting each would test the
 * helper, not the wiring.
 */

const admin = (): SessionUser => adminUser;
let adminUser: SessionUser;

describe("recordAudit (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "root", name: "Root", passwordHash: "x", role: "admin" })
      .returning();
    adminUser = { id: row.id, username: row.username, name: row.name, role: row.role };
  });

  afterAll(async () => {
    await client.close();
  });

  it("inserts the full shape (entity, id, action, summary) and defaults summary to null", async () => {
    await recordAudit(appDb, admin(), "transaction", "abc-123", "create", "Movimiento creado: $15.000 Super");
    await recordAudit(appDb, admin(), "goal", "", "delete");
    const rows = await db.select().from(auditLog).orderBy(auditLog.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorId: admin().id,
      entity: "transaction",
      entityId: "abc-123",
      action: "create",
      summary: "Movimiento creado: $15.000 Super",
    });
    expect(rows[1].summary).toBeNull();
    expect(rows[1].entityId).toBe("");
  });

  it("never throws — a broken audit sink cannot fail a mutation", async () => {
    await db.execute(`drop table audit_log`);
    // Resolves (logs) instead of throwing; the mutation is already committed.
    await expect(
      recordAudit(appDb, admin(), "settings", "app", "update", "boom"),
    ).resolves.toBeUndefined();
    await db.execute(
      `create table audit_log (
         "id" uuid primary key default gen_random_uuid(),
         "actor_id" uuid not null references "users"("id") on delete restrict,
         "entity" text not null,
         "entity_id" text not null,
         "action" text not null,
         "summary" text,
         "created_at" timestamptz not null default now()
       )`,
    );
  });

  it("formats audit amounts through the sanctioned money parser (exact cents)", () => {
    expect(auditAmount("15000")).toBe("$\u00A015.000");
    expect(auditAmount("1.234,56")).toBe("$\u00A01.234,56");
    expect(auditAmount("no-valido")).toBe("no-valido");
  });
});

describe("audit wiring on representative mutations (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let memberId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "root", name: "Root", passwordHash: "x", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    const [mate] = await db
      .insert(users)
      .values({ username: "ana", name: "Ana", passwordHash: "x" })
      .returning();
    memberId = mate.id;
    // Mirror category required by the loan-payment service (seeded in prod).
    await db.insert(categories).values({ name: "Pago de préstamos", kind: "expense" });
  });

  afterAll(async () => {
    await client.close();
  });

  it("createTransaction → one transaction/create row with an amount summary", async () => {
    const [category] = await db
      .insert(categories)
      .values({ name: "Super", kind: "expense" })
      .returning();
    const parsed = movementSchema.safeParse({
      date: "2026-10-01",
      amount: "15000",
      type: "expense",
      categoryId: category.id,
      memberId: memberId,
      groupId: "",
      scope: "common",
      note: "Super",
      paymentMethod: "cash",
      cardId: "",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(await createTransaction(appDb, admin, parsed.data)).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entity, "transaction"))
      .orderBy(auditLog.createdAt);
    expect(row).toMatchObject({
      actorId: admin.id,
      entity: "transaction",
      action: "create",
      summary: "Movimiento creado: $\u00A015.000 \u2014 Super",
    });
  });

  it("addLoanPayment → one loan_payment/payment row naming the loan", async () => {
    const { loanId } = await (async () => {
      const result = await createLoan(appDb, admin, {
        name: "Préstamo auto",
        kind: "other",
        entity: "Banco",
        scope: "common",
        memberId: "",
        principal: "1000",
        annualRate: "",
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
      });
      expect(result).toEqual({ ok: true });
      const [loanRow] = await db.select().from(auditLog).where(eq(auditLog.entity, "loan"));
      expect(loanRow).toMatchObject({ action: "create", summary: "Préstamo creado: Préstamo auto" });
      const [loan] = await db.select({ id: loans.id }).from(loans);
      return { loanId: loan.id };
    })();

    const result = await addLoanPayment(appDb, admin, loanId, {
      amount: "500",
      date: "2026-10-02",
      note: "",
      memberId: "",
    });
    expect(result).toEqual({ ok: true });
    const [paymentRow] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entity, "loan_payment"));
    expect(paymentRow).toMatchObject({
      actorId: admin.id,
      entity: "loan_payment",
      action: "payment",
      summary: "Pago de préstamo Préstamo auto: $\u00A0500",
    });
  });

  it("addContribution → one contribution row with the goal name", async () => {
    // The contribution mirrors into transactions: both mirror categories must exist.
    await db.insert(categories).values([
      { name: "Ahorro e inversión", kind: "expense" },
      { name: "Recupero de ahorro", kind: "income" },
    ]);
    expect(
      await createGoal(appDb, admin, {
        name: "Fondo",
        kind: "savings",
        scope: "common",
        memberId: "",
        target: "",
        deadline: "",
        currentValue: "",
        institution: "",
        annualRate: "",
        accrualMode: "",
        currency: "",
      }),
    ).toEqual({ ok: true });
    const [goal] = await db.select({ id: savingsGoals.id }).from(savingsGoals);

    expect(
      await addContribution(appDb, admin, goal.id, {
        amount: "100",
        kind: "deposit",
        date: "2026-10-02",
        note: "",
        memberId: "",
      }),
    ).toEqual({ ok: true });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.entity, "contribution"));
    expect(row).toMatchObject({
      entity: "contribution",
      action: "create",
      summary: "Aporte a Fondo: $\u00A0100",
    });
  });

  it("setForMonth → one budget/set row with the month and category count", async () => {
    const [category] = await db
      .insert(categories)
      .values({ name: "Mercado", kind: "expense" })
      .returning();
    expect(
      await setForMonth(appDb, admin, "2026-10", [
        { categoryId: category.id, amount: "500" },
      ]),
    ).toEqual({ ok: true });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.entity, "budget"));
    expect(row).toMatchObject({
      entity: "budget",
      action: "set",
      summary: "Presupuesto 2026-10: 1 categoría",
    });
  });

  it("listAudits returns newest first with actor names and filters", async () => {
    const page = await listAudits(appDb, { entity: "loan_payment" }, 1, 50);
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ actorName: "Root", action: "payment" });

    const byActor = await listAudits(appDb, { actorId: admin.id }, 1, 50);
    expect(byActor.total).toBe(6);
    expect(byActor.rows.map((r) => r.entity)).toEqual([
      "budget",
      "contribution",
      "goal",
      "loan_payment",
      "loan",
      "transaction",
    ]);

    const unknownEntity = await listAudits(appDb, { entity: "ghost" }, 1, 50);
    expect(unknownEntity.total).toBe(0);
    expect(AUDIT_ENTITIES).toContain("import");
  });
});
