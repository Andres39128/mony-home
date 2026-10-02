import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { budgets, categories, loanPayments, loans, savingsGoals, transactions, users } from "@/db/schema";
import {
  daysUntilDayOfMonth,
  deriveNotifications,
  type DerivedNotification,
} from "@/features/notifications/service";

/** Noon UTC = mid-day in the app timezone — todayIso() never shifts the day. */
const AT = (iso: string) => new Date(`${iso}T12:00:00Z`);

let db: PgliteDatabase;
let appDb: Database;
let client: PGlite;

let memberId = "";

/** Completed cash expense (budget spent side). */
function spent(categoryId: string, cents: number, date = "2026-10-10") {
  return db.insert(transactions).values({
    memberId,
    categoryId,
    amountCents: cents,
    type: "expense",
    scope: "common",
    paymentMethod: "cash",
    date,
  });
}

/** Revolving card with a statement day (default far from the test dates). */
async function card(name: string, statementDay: number, isActive = true) {
  const [row] = await db
    .insert(loans)
    .values({
      name,
      kind: "credit_card",
      entity: "Banco",
      scope: "common",
      principalCents: 0,
      amortizationMode: "revolving",
      creditLimitCents: 5_000_000,
      statementDay,
      isActive,
    })
    .returning();
  return row;
}

/** Bank loan with the four gate CHECK fields (default cuota far away). */
async function bankLoan(
  name: string,
  cuotaDay: number,
  overrides: Partial<typeof loans.$inferInsert> = {},
) {
  const [row] = await db
    .insert(loans)
    .values({
      name,
      kind: "investment_line",
      entity: "Banco",
      scope: "common",
      principalCents: 3_000_000,
      amortizationMode: "bank",
      chargedRateBp: 1200,
      termMonths: 12,
      fixedCuotaCents: 100_000,
      cuotaDay,
      ...overrides,
    })
    .returning();
  return row;
}

/** Savings goal with a deadline (deadline is savings-only by design). */
function goal(name: string, deadline: string, isActive = true) {
  return db.insert(savingsGoals).values({
    name,
    kind: "savings",
    scope: "common",
    deadline,
    isActive,
  });
}

/** Savings goal WITHOUT a deadline — never notifies. */
function plainGoal(name: string) {
  return db.insert(savingsGoals).values({ name, kind: "savings", scope: "common" });
}

let catBajo = "";
let catLimite = "";
let catSobre = "";

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  appDb = db as unknown as Database;

  const [member] = await db
    .insert(users)
    .values({ username: "andres", name: "Andrés", passwordHash: "x" })
    .returning();
  memberId = member.id;

  const makeCategory = (name: string) =>
    db.insert(categories).values({ name, kind: "expense", color: "#a8dadc" }).returning();

  const [bajo] = await makeCategory("Bajo");
  const [limite] = await makeCategory("Límite");
  const [sobre] = await makeCategory("Sobre");
  catBajo = bajo.id;
  catLimite = limite.id;
  catSobre = sobre.id;

  // Budget month of the injected "now" (2026-10): 79% (silent), 80% (info
  // threshold boundary) and 120% (over → warn).
  await db.insert(budgets).values([
    { month: "2026-10-01", categoryId: catBajo, amountCents: 100_000 },
    { month: "2026-10-01", categoryId: catLimite, amountCents: 100_000 },
    { month: "2026-10-01", categoryId: catSobre, amountCents: 100_000 },
  ]);
  await spent(catBajo, 79_000);
  await spent(catLimite, 80_000);
  await spent(catSobre, 120_000);

  // Cards: hoy (0 días), dentro de la ventana (3), fuera (19).
  await card("Cerca", 18); // 2026-10-15 → 3 días
  await card("Hoy", 15); // → 0 días
  await card("Lejos", 3); // → 31 − 15 + 3 = 19 días
  // Wrap-lab cards for the September cases (30-day month).
  await card("Wrap dia 1", 1);
  await card("Wrap dia 3", 3);

  // Bank loans: cuota inside the window, and a settled one (outstanding ≤ 0
  // via a payment that dwarfs principal + any interest — no cuota to announce).
  await bankLoan("Cuota cercana", 17); // → 2 días
  await bankLoan("Cuota lejana", 25); // → 10 días
  const saldada = await bankLoan("Saldada", 16, { principalCents: 100 });
  await db.insert(loanPayments).values({
    loanId: saldada.id,
    memberId,
    kind: "payment",
    amountCents: 999_999_999,
    date: "2026-01-02",
  });
});

afterAll(async () => {
  await client.close();
});

describe("daysUntilDayOfMonth (pure — the wrap arithmetic)", () => {
  it("counts down inside the same month", () => {
    expect(daysUntilDayOfMonth("2026-09-27", 3)).toBe(6);
    expect(daysUntilDayOfMonth("2026-10-15", 18)).toBe(3);
  });

  it("wraps to the next month with the CURRENT month's length", () => {
    // 30-day September: 27→1 is 4 days out (silent), 28→1 is 3 (fires).
    expect(daysUntilDayOfMonth("2026-09-27", 1)).toBe(4);
    expect(daysUntilDayOfMonth("2026-09-28", 1)).toBe(3);
  });

  it("is February-safe", () => {
    expect(daysUntilDayOfMonth("2027-02-26", 1)).toBe(3); // 28-day month
    expect(daysUntilDayOfMonth("2028-02-26", 1)).toBe(4); // leap year
  });

  it("treats today as day 0", () => {
    expect(daysUntilDayOfMonth("2026-10-15", 15)).toBe(0);
    expect(daysUntilDayOfMonth("2026-10-15", 14)).toBe(30); // next month's 14th (31-day Oct)
  });
});

describe("deriveNotifications (integration on PGlite, injected now)", () => {
  it("fires each rule with stable ids at now = 2026-10-15", async () => {
    const items = await deriveNotifications(appDb, AT("2026-10-15"));
    const byId = new Map(items.map((item) => [item.id, item]));

    // Budget: 80% info boundary, 120% over warn, 79% silent — plus the
    // global totals (279.000/300.000 = 93% ≥ 80 → warn; asserted below).
    const limite = byId.get(`budget-${catLimite}`);
    expect(limite).toMatchObject({ severity: "info", title: "Presupuesto de Límite al 80%" });
    const sobre = byId.get(`budget-${catSobre}`);
    expect(sobre).toMatchObject({ severity: "warn", title: "Presupuesto de Sobre al 120%" });
    expect(byId.get(`budget-${catBajo}`)).toBeUndefined();

    // Card close: today (0 días) and 3 days; the 19-day card stays silent.
    // Title order: warn first, then info alphabetically (Cerca < Hoy).
    const cardCloses = items.filter((i) => i.id.startsWith("card-close-"));
    expect(cardCloses.map((i) => i.title)).toEqual([
      "La tarjeta Cerca cierra en 3 días",
      "La tarjeta Hoy cierra hoy",
    ]);

    // Bank cuota: inside the window fires, outside is silent.
    const cuotas = items.filter((i) => i.id.startsWith("cuota-"));
    expect(cuotas.map((i) => i.title)).toEqual(["Cuota de Cuota cercana el día 17"]);
  });

  it("keeps goal notifications inside the 30-day window with warn ≤ 7", async () => {
    await plainGoal("Meta sin plazo");
    await goal("Vence en 31", "2026-11-15"); // silent boundary
    await goal("Vence en 30", "2026-11-14"); // info boundary
    await goal("Vence en 5", "2026-10-20"); // warn (≤ 7)
    await goal("Vencida", "2026-10-14"); // overdue → warn
    await goal("Meta inactiva", "2026-10-16", false); // archived → silent

    const items = await deriveNotifications(appDb, AT("2026-10-15"));
    const goalItems = items.filter((i) => i.id.startsWith("goal-"));
    expect(goalItems).toHaveLength(3);
    expect(goalItems.find((i) => i.title.includes("Vence en 31"))).toBeUndefined();
    expect(goalItems.find((i) => i.title.includes("Vence en 30"))).toMatchObject({ severity: "info" });
    expect(goalItems.find((i) => i.title.includes("Vence en 5"))).toMatchObject({ severity: "warn" });
    expect(goalItems.find((i) => i.title.includes("Vencida"))).toMatchObject({
      severity: "warn",
      title: "La meta Vencida venció el 14 de oct de 2026",
    });
  });

  it("handles the month wrap end to end (Sep 27/28 against day 1 and 3)", async () => {
    // Today Sep 27: day 3 → 6 days out, day 1 → 4 days out — both silent.
    const sep27 = await deriveNotifications(appDb, AT("2026-09-27"));
    // No October budgets exist, so no budget items pollute the assertion.
    expect(sep27.filter((i) => i.id.startsWith("card-close-"))).toHaveLength(0);

    // Today Sep 28: day 1 wraps to 3 days — the exact boundary fires.
    const sep28 = await deriveNotifications(appDb, AT("2026-09-28"));
    const closes = sep28.filter((i) => i.id.startsWith("card-close-"));
    expect(closes.map((i) => i.title)).toEqual(["La tarjeta Wrap dia 1 cierra en 3 días"]);

    // The same wrap applies to bank cuota days.
    await bankLoan("Cuota wrap", 1);
    const sep28b = await deriveNotifications(appDb, AT("2026-09-28"));
    expect(sep28b.some((i) => i.title === "Cuota de Cuota wrap el día 1")).toBe(true);
  });

  it("ignores inactive loans and sorted warn-first then by title", async () => {
    await card("Lejana inactiva", 16, false); // would fire (1 day) if active

    const items = await deriveNotifications(appDb, AT("2026-10-15"));
    expect(items.some((i) => i.title.includes("Lejana inactiva"))).toBe(false);

    const severities = items.map((i) => i.severity);
    const warns = severities.filter((s) => s === "warn");
    const infos = severities.filter((s) => s === "info");
    expect(severities).toEqual([...warns, ...infos]);
    const titles = items.map((i) => i.title);
    // Same grouping the service applies: warn block first, each block
    // alphabetically by title.
    const byTitle = (a: string, b: string) => a.localeCompare(b, "es");
    const expectedTitles = [
      ...titles.filter((_, index) => severities[index] === "warn").sort(byTitle),
      ...titles.filter((_, index) => severities[index] === "info").sort(byTitle),
    ];
    expect(titles).toEqual(expectedTitles);

    // Stable ids: a second derivation of the same state is identical.
    const again: DerivedNotification[] = await deriveNotifications(appDb, AT("2026-10-15"));
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it("fires the global budget totals only at ≥ 80% of the plan", async () => {
    // Current global: 279.000 spent of 300.000 planned = 93% → present (still
    // under 100%, so info, not warn).
    const october = await deriveNotifications(appDb, AT("2026-10-15"));
    expect(october.find((i) => i.id === "budget-total")).toMatchObject({ severity: "info" });

    // A month without budgets (planned 0) never fires the totals item.
    const november = await deriveNotifications(appDb, AT("2026-11-15"));
    expect(november.find((i) => i.id === "budget-total")).toBeUndefined();
  });
});
