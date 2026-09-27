import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { budgets, categories, loanPayments, loans, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
import {
  buildFinanceContext,
  monthLabel,
  toPromptContext,
} from "@/features/insights/context";

/**
 * Insights context suite: exact pre-computed figures in every section (the
 * LLM narrates over them, so they must be right), month-over-month deltas
 * with the small-sample guard, top-5 + "otros" rollup, empty-month behavior
 * and the es-AR prompt rendering — against in-memory Postgres.
 *
 * Fixture (cents):
 *   2026-09 expenses: Alquiler 150000, Supermercado 60000, Ocio 50000,
 *   Transporte 25000, Servicios 12000, Salud 8000, Varios 1000 → 306000.
 *   2026-08 expenses: Alquiler 150000, Supermercado 48000, Transporte 25000,
 *   Ocio 20000, Servicios 20000 → 263000. 2026-07: Varios 100000.
 *   Income 2026-09: 800000. Budgets 2026-09: Supermercado 100000,
 *   Transporte 50000. Bolsas: Mercado (savings, con tasa, neto 60000),
 *   Ocio (inversión, neto 50000).
 */
describe("insights context (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let memberId: string;

  const MONTH = "2026-09";
  const TODAY = "2026-09-15";

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;

    const [user] = await db
      .insert(users)
      .values({ username: "andres", name: "Andrés", passwordHash: "x" })
      .returning();
    memberId = user.id;

    const expenseNames = [
      "Supermercado",
      "Transporte",
      "Ocio",
      "Servicios",
      "Alquiler",
      "Salud",
      "Varios",
    ];
    const categoryRows = await db
      .insert(categories)
      .values([
        ...expenseNames.map((name) => ({ name, kind: "expense" as const })),
        { name: "Sueldo", kind: "income" as const },
      ])
      .returning();
    const categoryId = (name: string): string => {
      const found = categoryRows.find((row) => row.name === name);
      if (!found) throw new Error(`fixture category ${name} missing`);
      return found.id;
    };

    // Bolsas fixture: one rate-bearing savings bag (neto 60000) and one
    // investment (neto 50000). Created "today" so the lazy daily accrual has
    // no complete days to fill → deterministic net figures.
    const [mercado] = await db
      .insert(savingsGoals)
      .values({
        name: "Mercado",
        kind: "savings",
        scope: "common",
        institution: "Banco Nación",
        annualRateBp: 3550,
        accrualMode: "simple",
      })
      .returning();
    const [ocioBolsa] = await db
      .insert(savingsGoals)
      .values({ name: "Ocio", kind: "investment", scope: "common" })
      .returning();
    await db.insert(savingsContributions).values([
      { goalId: mercado.id, memberId, kind: "deposit", amountCents: 60_000, date: "2026-09-03" },
      { goalId: ocioBolsa.id, memberId, kind: "deposit", amountCents: 50_000, date: "2026-09-04" },
    ]);

    await db.insert(transactions).values([
      // 2026-09 — income
      { date: "2026-09-05", amountCents: 800_000, type: "income", categoryId: categoryId("Sueldo"), memberId },
      // 2026-09 — expenses (total 306000)
      { date: "2026-09-01", amountCents: 150_000, type: "expense", categoryId: categoryId("Alquiler"), memberId, scope: "common" },
      { date: "2026-09-03", amountCents: 20_000, type: "expense", categoryId: categoryId("Supermercado"), memberId },
      { date: "2026-09-08", amountCents: 20_000, type: "expense", categoryId: categoryId("Supermercado"), memberId },
      { date: "2026-09-12", amountCents: 20_000, type: "expense", categoryId: categoryId("Supermercado"), memberId },
      { date: "2026-09-04", amountCents: 25_000, type: "expense", categoryId: categoryId("Ocio"), memberId, scope: "individual" },
      { date: "2026-09-11", amountCents: 25_000, type: "expense", categoryId: categoryId("Ocio"), memberId, scope: "individual" },
      { date: "2026-09-06", amountCents: 25_000, type: "expense", categoryId: categoryId("Transporte"), memberId },
      { date: "2026-09-07", amountCents: 12_000, type: "expense", categoryId: categoryId("Servicios"), memberId },
      { date: "2026-09-09", amountCents: 8_000, type: "expense", categoryId: categoryId("Salud"), memberId },
      { date: "2026-09-10", amountCents: 1_000, type: "expense", categoryId: categoryId("Varios"), memberId },
      // 2026-08 — expenses (total 263000)
      { date: "2026-08-02", amountCents: 150_000, type: "expense", categoryId: categoryId("Alquiler"), memberId },
      { date: "2026-08-05", amountCents: 48_000, type: "expense", categoryId: categoryId("Supermercado"), memberId },
      { date: "2026-08-08", amountCents: 25_000, type: "expense", categoryId: categoryId("Transporte"), memberId },
      { date: "2026-08-11", amountCents: 20_000, type: "expense", categoryId: categoryId("Ocio"), memberId },
      { date: "2026-08-14", amountCents: 20_000, type: "expense", categoryId: categoryId("Servicios"), memberId },
      // 2026-07 — expenses (trend window)
      { date: "2026-07-10", amountCents: 100_000, type: "expense", categoryId: categoryId("Varios"), memberId },
    ]);

    await db.insert(budgets).values([
      { month: "2026-09-01", categoryId: categoryId("Supermercado"), amountCents: 100_000 },
      { month: "2026-09-01", categoryId: categoryId("Transporte"), amountCents: 50_000 },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("pre-computes exact month summary figures", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    // Budget totals reuse budgets.getMonth semantics: spent is ALL household
    // expenses of the month against the plan — the same numbers the
    // /presupuesto page shows (not just budgeted categories).
    expect(ctx.summary).toEqual({
      incomeCents: 800_000,
      expenseCents: 306_000,
      balanceCents: 494_000,
      budget: { plannedCents: 150_000, spentCents: 306_000, pct: 204 },
    });
  });

  it("lists top-5 categories with pct and vs-budget, rolling the rest into otros", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    expect(ctx.topExpenseCategories.map((c) => [c.name, c.cents, c.pct])).toEqual([
      ["Alquiler", 150_000, 49.02],
      ["Supermercado", 60_000, 19.61],
      ["Ocio", 50_000, 16.34],
      ["Transporte", 25_000, 8.17],
      ["Servicios", 12_000, 3.92],
    ]);
    // Only budgeted categories carry a budget annotation (planned > 0).
    expect(ctx.topExpenseCategories.find((c) => c.name === "Supermercado")?.budget).toEqual({
      plannedCents: 100_000,
      pct: 60,
      status: "ok",
    });
    expect(ctx.topExpenseCategories.find((c) => c.name === "Alquiler")?.budget).toBeNull();
    // Salud (8000) + Varios (1000) roll up.
    expect(ctx.otherCategories).toEqual({ name: "Otros", cents: 9_000, pct: 2.94 });
  });

  it("reports notable month-over-month changes with the small-sample guard", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    expect(ctx.categoryChanges).toEqual([
      { name: "Supermercado", currentCents: 60_000, previousCents: 48_000, deltaPct: 25 },
      { name: "Ocio", currentCents: 50_000, previousCents: 20_000, deltaPct: 150 },
      { name: "Servicios", currentCents: 12_000, previousCents: 20_000, deltaPct: -40 },
      // Salud is new spend this month: no base → null instead of a huge ratio.
      { name: "Salud", currentCents: 8_000, previousCents: 0, deltaPct: null },
    ]);
    // Unchanged (Alquiler, Transporte: delta 0) and below the 2% share guard
    // (Varios) never appear.
  });

  it("includes savings bolsas summary (net balances, institution and rates)", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    // Active first, savings before investments, then by name.
    expect(ctx.bolsas).toEqual([
      expect.objectContaining({
        name: "Mercado",
        institution: "Banco Nación",
        kind: "savings",
        netCents: 60_000,
        annualRateBp: 3550,
        accrualMode: "simple",
      }),
      expect.objectContaining({
        name: "Ocio",
        kind: "investment",
        netCents: 50_000,
        annualRateBp: null,
        accrualMode: null,
      }),
    ]);
  });

  it("summarizes the 12-month trend against the exact average", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    // Window 2025-10..2026-09: (100000 + 263000 + 306000) / 12 = 55750.
    expect(ctx.trend).toEqual({
      months: 12,
      avgExpenseCents: 55_750,
      currentVsAvgPct: 448.88,
    });
  });

  it("adds raw data-completeness facts, never projections", async () => {
    const current = await buildFinanceContext(appDb, MONTH, TODAY);
    expect(current.isCurrentMonth).toBe(true);
    expect(current.daysElapsed).toBe(15);
    expect(current.daysInMonth).toBe(30);
    expect(current.notes).toEqual([
      "El mes está en curso: día 15 de 30; los totales son parciales.",
    ]);

    const past = await buildFinanceContext(appDb, "2026-08", TODAY);
    expect(past.notes).toEqual(["El mes está completo (31 días)."]);
  });

  it("returns zeros, no changes and a no-movements note for an empty month", async () => {
    const ctx = await buildFinanceContext(appDb, "2026-10", "2026-10-10");
    expect(ctx.summary).toEqual({
      incomeCents: 0,
      expenseCents: 0,
      balanceCents: 0,
      budget: null,
    });
    expect(ctx.topExpenseCategories).toEqual([]);
    expect(ctx.otherCategories).toBeNull();
    expect(ctx.categoryChanges).toEqual([]);
    expect(ctx.notes).toContain("No hay movimientos registrados en este mes.");
    // Bolsas still report their balances in an empty month.
    expect(ctx.bolsas).toHaveLength(2);
  });

  it("renders the prompt context with es-AR formatted amounts", async () => {
    const ctx = await buildFinanceContext(appDb, MONTH, TODAY);
    const prompt = toPromptContext(ctx);
    const resumen = prompt.resumen as Record<string, string>;
    expect(resumen.ingresos).toBe("$ 8.000,00");
    expect(resumen.gastos).toBe("$ 3.060,00");
    const supermercado = (
      prompt.mayores_gastos_por_categoria as { categoria: string; gasto: string }[]
    ).find((row) => row.categoria === "Supermercado");
    expect(supermercado?.gasto).toBe("$ 600,00");
    const cambios = prompt.cambios_vs_mes_anterior as {
      categoria: string;
      variacion: string;
    }[];
    expect(cambios.find((row) => row.categoria === "Supermercado")?.variacion).toBe("+25%");
    expect(cambios.find((row) => row.categoria === "Salud")?.variacion).toBe(
      "gasto nuevo (sin gasto el mes anterior)",
    );
    // Bolsas render with pre-formatted balances and the rate + its mode.
    const bolsas = prompt.bolsas as {
      nombre: string;
      saldo_neto: string;
      tasa?: string;
    }[];
    expect(bolsas.find((row) => row.nombre === "Mercado")).toMatchObject({
      saldo_neto: "$ 600,00",
      tasa: "35,5% TNA (simple)",
    });
    expect(bolsas.find((row) => row.nombre === "Ocio")?.tasa).toBeUndefined();
  });

  it("labels months in neutral Spanish", () => {
    expect(monthLabel("2026-09")).toBe("septiembre 2026");
    expect(monthLabel("2026-01")).toBe("enero 2026");
  });

  it("narrates investments at their valuation, never a bare ledger 0", async () => {
    // Valuation-only investment: no contributions, manual current value —
    // the contributions-ledger net alone would narrate $0.
    await db.insert(savingsGoals).values({
      name: "Cedear",
      kind: "investment",
      scope: "common",
      currentValueCents: 1_200_000,
      valueUpdatedAt: new Date("2026-09-20T12:00:00Z"),
    });
    const ctx = await buildFinanceContext(appDb, "2026-09", "2026-09-26");
    const cedear = ctx.bolsas.find((bolsa) => bolsa.name === "Cedear")!;
    expect(cedear.kind).toBe("investment");
    expect(cedear.netCents).toBe(1_200_000);
    const prompt = toPromptContext(ctx) as ReturnType<typeof toPromptContext>;
    const bolsas = prompt.bolsas as Array<Record<string, unknown>>;
    expect(bolsas.find((bolsa) => bolsa.nombre === "Cedear")?.saldo_neto).toBe("$ 12.000,00");
    // Savings bags keep the ledger net (Mercado stays at its deposits).
    expect(ctx.bolsas.find((bolsa) => bolsa.name === "Mercado")?.netCents).toBe(60_000);
  });
});

/** Prompt shape the debt/card assertions read (typed — no any). */
const promptOf = (ctx: Awaited<ReturnType<typeof buildFinanceContext>>) =>
  toPromptContext(ctx) as {
    medios_de_pago: unknown;
    deudas: Record<string, unknown>[];
    tarjetas: Record<string, unknown>[];
    deuda_total: string;
    patrimonio: Record<string, string>;
  };

/**
 * Debts / cards / payment-method section: isolated fixture so the classic
 * figures above stay untouched. One revolving card (cupo 1.000.000, cuota de
 * manejo 25.000, corte día 25) with two September purchases (50.000), manual
 * interest 5.000 and a payment 40.000 → saldo 15.000, disponible 985.000;
 * one fixed mortgage (500.000) → deuda total 515.000.
 */
describe("insights context — deudas, tarjetas y medios de pago", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let memberId: string;
  let categoryId: string;
  let cardId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [user] = await db
      .insert(users)
      .values({ username: "andres", name: "Andrés", passwordHash: "x" })
      .returning();
    memberId = user.id;
    const [cat] = await db
      .insert(categories)
      .values({ name: "Supermercado", kind: "expense" })
      .returning();
    categoryId = cat.id;

    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa Oro",
        kind: "credit_card",
        entity: "Galicia",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents: 1_000_000,
        managementFeeCents: 25_000,
        statementDay: 25,
      })
      .returning();
    cardId = card.id;
    await db.insert(loans).values({
      name: "Hipoteca",
      kind: "mortgage",
      entity: "Banco Nación",
      scope: "common",
      principalCents: 500_000,
    });
    // The mortgaged apartment: bank-style loan carrying the property value.
    // Created "now" → the daily accrual has no elapsed days → no interest
    // rows, outstanding stays at the principal (deterministic).
    await db.insert(loans).values({
      name: "Apartamento",
      kind: "mortgage",
      entity: "Davivienda",
      scope: "common",
      principalCents: 200_000,
      amortizationMode: "bank",
      chargedRateBp: 1295,
      fixedCuotaCents: 20_000,
      termMonths: 240,
      cuotaDay: 5,
      propertyValueCents: 800_000,
    });

    await db.insert(transactions).values([
      // Cash expense 10.000 + card purchases 50.000 → split del mes.
      { date: "2026-09-05", amountCents: 10_000, type: "expense", categoryId, memberId },
      {
        date: "2026-09-14", amountCents: 30_000, type: "expense", categoryId, memberId,
        paymentMethod: "card", cardLoanId: cardId,
      },
      {
        date: "2026-09-16", amountCents: 20_000, type: "expense", categoryId, memberId,
        paymentMethod: "card", cardLoanId: cardId,
      },
    ]);
    await db.insert(loanPayments).values([
      { loanId: cardId, memberId: null, kind: "interest", amountCents: 5_000, date: "2026-09-20", note: "Interés de ciclo" },
      { loanId: cardId, memberId, kind: "payment", amountCents: 40_000, date: "2026-09-20" },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("splits the month expenses by payment method", async () => {
    const ctx = await buildFinanceContext(appDb, "2026-09", "2026-09-26");
    expect(ctx.paymentSplit).toEqual({ cashCents: 10_000, cardCents: 50_000 });
  });

  it("separates fixed debts from revolving cards with the full cupo facts", async () => {
    const ctx = await buildFinanceContext(appDb, "2026-09", "2026-09-26");
    expect(ctx.deudas).toEqual([
      { name: "Apartamento", entity: "Davivienda", kind: "mortgage", outstandingCents: 200_000, isActive: true },
      { name: "Hipoteca", entity: "Banco Nación", kind: "mortgage", outstandingCents: 500_000, isActive: true },
    ]);
    expect(ctx.tarjetas).toHaveLength(1);
    expect(ctx.tarjetas[0]).toMatchObject({
      name: "Visa Oro",
      creditLimitCents: 1_000_000,
      usedCents: 15_000,
      availableCents: 985_000,
      outstandingCents: 15_000,
      purchasesCents: 50_000,
      interestCents: 5_000,
      managementFeeCents: 25_000,
      statementDay: 25,
    });
    // Card outstanding + mortgage, saldos a favor never subtract.
    // Card 15.000 + Hipoteca 500.000 + Apartamento 200.000.
    expect(ctx.totalDebtCents).toBe(715_000);
  });

  it("renders deudas, tarjetas, medios de pago and deuda total for the prompt", async () => {
    const ctx = await buildFinanceContext(appDb, "2026-09", "2026-09-26");
    const prompt = promptOf(ctx);
    expect(prompt.medios_de_pago).toEqual({
      gastos_en_efectivo: "$ 100,00",
      gastos_con_tarjeta: "$ 500,00",
    });
    expect(prompt.deudas).toEqual([
      expect.objectContaining({
        nombre: "Apartamento",
        tipo: "hipoteca",
        saldo_pendiente: "$ 2.000,00",
        estado: "activa",
      }),
      expect.objectContaining({
        nombre: "Hipoteca",
        tipo: "hipoteca",
        saldo_pendiente: "$ 5.000,00",
        estado: "activa",
      }),
    ]);
    expect(prompt.tarjetas[0]).toMatchObject({
      nombre: "Visa Oro",
      cupo_total: "$ 10.000,00",
      cupo_usado: "$ 150,00",
      cupo_disponible: "$ 9.850,00",
      saldo_pendiente: "$ 150,00",
      compras_con_tarjeta: "$ 500,00",
      intereses_generados: "$ 50,00",
      cuota_de_manejo: "$ 250,00",
      dia_de_corte: 25,
      estado: "activa",
    });
    expect(prompt.tarjetas[0].saldo_a_favor).toBeUndefined();
    expect(prompt.deuda_total).toBe("$ 7.150,00");
  });

  it("reports a saldo a favor instead of a negative pending balance", async () => {
    // Overpay the card: 50.000 pago extra → outstanding −35.000 (a favor).
    await db
      .insert(loanPayments)
      .values({ loanId: cardId, memberId, kind: "payment", amountCents: 50_000, date: "2026-09-21" });
    const ctx = await buildFinanceContext(appDb, "2026-09", "2026-09-26");
    expect(ctx.tarjetas[0].outstandingCents).toBe(-35_000);
    // A favor: saldo_pendiente floors at 0, saldo_a_favor shows the credit,
    // disponible caps at the cupo and the debt total ignores the favor.
    const prompt = promptOf(ctx);
    expect(prompt.tarjetas[0].saldo_pendiente).toBe("$ 0,00");
    expect(prompt.tarjetas[0].saldo_a_favor).toBe("$ 350,00");
    expect(prompt.tarjetas[0].cupo_disponible).toBe("$ 10.000,00");
    expect(prompt.deuda_total).toBe("$ 7.000,00");
  });
});
