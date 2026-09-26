/**
 * Seed script — `npm run db:seed`.
 *
 * Idempotent-ish: rows are looked up by natural keys before inserting
 * (username, category name, group name, month+category), so re-runs
 * skip what already exists instead of duplicating it.
 *
 * `SEED_DEMO_DATA=false` turns this into a production bootstrap: categories
 * and the admin user only — no demo members, group, transactions
 * or budgets.
 *
 * Seed DATA (category names, notes) is user-facing and therefore Spanish.
 */
import { hash } from "@node-rs/argon2";
import { gte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "../lib/config.ts";
import { budgets, categories, expenseGroups, loanPayments, loans, savingsContributions, savingsGoals, transactions, users } from "./schema.ts";

/** Any Postgres drizzle database — postgres-js in the CLI, PGlite in tests. */
type SeedDb = PgDatabase<PgQueryResultHKT>;

/** ISO date (YYYY-MM-DD) for the given day of the current month. */
function isoDay(year: number, month: number, day: number, lastDay: number): string {
  const clamped = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/**
 * The old placeholder password, refused at seed time so a forgotten variable
 * can never ship a guessable credential. Lives here (not in the shared env
 * schema) because seeding is a CLI concern — an invalid value must not break
 * every runtime request path.
 */
export const PLACEHOLDER_SEED_PASSWORD = "changeme-on-first-login";

export async function seedDatabase(db: SeedDb, config: AppConfig): Promise<void> {
  // Guard: seeding is destructive-ish (writes users/categories); require an
  // explicit escape hatch before it runs against a production database.
  // ponytail: this trusts NODE_ENV, not the database itself — DATABASE_URL is
  // always the remote pooler (even in dev), so no host heuristic can tell
  // them apart. A real prod-DB detector would need an explicit marker (e.g.
  // a SEED_TARGET env allowlist) if NODE_ENV ever diverges from the target.
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PROD !== "yes") {
    throw new Error("Refusing to seed in production without SEED_ALLOW_PROD=yes");
  }
  // Guards: the admin password has NO default — never seed a guessable
  // credential (the old placeholder) or a too-short one just because the
  // variable was forgotten. Enforced here, not in the env schema: this is a
  // seed-only concern.
  if (config.SEED_ADMIN_PASSWORD === undefined) {
    throw new Error(
      "SEED_ADMIN_PASSWORD is required to seed (it has no default anymore). Set it to a real password (min 8 chars) and re-run.",
    );
  }
  if (config.SEED_ADMIN_PASSWORD === PLACEHOLDER_SEED_PASSWORD) {
    throw new Error(
      `Refusing the placeholder password "${PLACEHOLDER_SEED_PASSWORD}". Set a real SEED_ADMIN_PASSWORD (min 8 chars) before seeding.`,
    );
  }
  if (config.SEED_ADMIN_PASSWORD.length < 8) {
    throw new Error(
      "SEED_ADMIN_PASSWORD must be at least 8 characters. Set a real password and re-run.",
    );
  }
  const password = config.SEED_ADMIN_PASSWORD;

  // --- Admin user (always; username is unique; conflicts skipped) ---
  const passwordHash = await hash(password);
  await db
    .insert(users)
    .values({ username: "admin", passwordHash, name: "Admin", role: "admin" as const })
    .onConflictDoNothing();

  // --- Categories (always; name is unique; conflicts skipped) ---
  // The last two are SYSTEM categories: the savings mirror writes them from
  // contribute() — deposits charge "Ahorro e inversión" (expense), withdrawals
  // credit "Recupero de ahorro" (income). Production mode needs them too.
  const expenseCategories = [
    ["Luz", "#f59e0b"],
    ["Agua", "#38bdf8"],
    ["Teléfono", "#a78bfa"],
    ["Internet", "#818cf8"],
    ["Supermercado", "#34d399"],
    ["Transporte", "#fbbf24"],
    ["Salud", "#f87171"],
    ["Ocio", "#f472b6"],
    ["Educación", "#60a5fa"],
    ["Alquiler", "#94a3b8"],
    ["Otros gastos", "#64748b"],
    ["Ahorro e inversión", "#0ea5e9"],
    // SYSTEM category: the loans mirror writes it from pay() — a loan payment
    // is an expense. Production mode needs it too.
    ["Pago de préstamos", "#fb7185"],
  ] as const;
  const incomeCategories = [
    ["Sueldo", "#22c55e"],
    ["Otros ingresos", "#4ade80"],
    ["Recupero de ahorro", "#14b8a6"],
  ] as const;

  await db
    .insert(categories)
    .values([
      ...expenseCategories.map(([name, color]) => ({ name, kind: "expense" as const, color })),
      ...incomeCategories.map(([name, color]) => ({ name, kind: "income" as const, color })),
    ])
    .onConflictDoNothing();

  if (!config.SEED_DEMO_DATA) return;

  const categoryRows = await db.select().from(categories);
  const categoryId = (name: string): string => {
    const found = categoryRows.find((c) => c.name === name);
    if (!found) throw new Error(`Seed category "${name}" missing after upsert`);
    return found.id;
  };

  // --- Demo members (username is unique; conflicts skipped) ---
  await db
    .insert(users)
    .values([
      { username: "andres", passwordHash, name: "Andrés" },
      { username: "maria", passwordHash, name: "María" },
    ])
    .onConflictDoNothing();

  const userRows = await db.select().from(users);
  const userId = (username: string): string => {
    const found = userRows.find((u) => u.username === username);
    if (!found) throw new Error(`Seed user "${username}" missing after upsert`);
    return found.id;
  };

  // --- Expense groups ---
  const groupRows = await db.select().from(expenseGroups);
  if (!groupRows.some((g) => g.name === "Vacaciones 2027")) {
    await db.insert(expenseGroups).values({
      name: "Vacaciones 2027",
      description: "Ahorro conjunto para las vacaciones de verano 2027",
    });
  }
  const groupRowsAfter = await db.select().from(expenseGroups);
  const groupId = (name: string): string => {
    const found = groupRowsAfter.find((g) => g.name === name);
    if (!found) throw new Error(`Seed expense group "${name}" missing after insert`);
    return found.id;
  };

  // --- Demo transactions for the CURRENT month (dates from today, never literals) ---
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const day = (d: number): string => isoDay(year, month, d, lastDay);

  const existingThisMonth = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(gte(transactions.date, day(1)));

  if (existingThisMonth.length === 0) {
    await db.insert(transactions).values([
      {
        date: day(1),
        amountCents: 850000,
        type: "income",
        categoryId: categoryId("Sueldo"),
        memberId: userId("andres"),
        scope: "individual",
        note: "Sueldo de Andrés",
      },
      {
        date: day(2),
        amountCents: 45300,
        type: "expense",
        categoryId: categoryId("Supermercado"),
        memberId: userId("andres"),
        scope: "common",
        note: "Compra semanal",
      },
      {
        date: day(5),
        amountCents: 28500,
        type: "expense",
        categoryId: categoryId("Luz"),
        memberId: userId("maria"),
        scope: "common",
        note: "Factura de luz",
      },
      {
        date: day(7),
        amountCents: 35000,
        type: "expense",
        categoryId: categoryId("Internet"),
        memberId: userId("andres"),
        scope: "common",
        note: "Fibra mensual",
      },
      {
        date: day(8),
        amountCents: 12000,
        type: "expense",
        categoryId: categoryId("Transporte"),
        memberId: userId("maria"),
        scope: "individual",
        note: "SUBE",
      },
      {
        date: day(10),
        amountCents: 150000,
        type: "expense",
        categoryId: categoryId("Ocio"),
        memberId: userId("andres"),
        scope: "common",
        groupId: groupId("Vacaciones 2027"),
        note: "Seña de alojamiento",
      },
      {
        date: day(12),
        amountCents: 62350,
        type: "expense",
        categoryId: categoryId("Supermercado"),
        memberId: userId("maria"),
        scope: "common",
        note: "Verdulería y almacén",
      },
      {
        date: day(15),
        amountCents: 50000,
        type: "income",
        categoryId: categoryId("Otros ingresos"),
        memberId: userId("maria"),
        scope: "common",
        note: "Venta de bicicleta",
      },
    ]);
  }

  // --- Budgets for the current month (unique month+category; conflicts skipped) ---
  await db
    .insert(budgets)
    .values([
      { month: day(1), categoryId: categoryId("Supermercado"), amountCents: 400000 },
      { month: day(1), categoryId: categoryId("Ocio"), amountCents: 150000 },
    ])
    .onConflictDoNothing();

  // --- Savings goals + investments (demo only; no unique key → check by name) ---
  // Each goal and its contributions are inserted in the same guard block, so a
  // re-run never duplicates either. Contributions are a separate ledger from
  // transactions on purpose (saving is not income/expense).
  const goalRows = await db.select().from(savingsGoals);
  if (!goalRows.some((g) => g.name === "Fondo de emergencia")) {
    const [goal] = await db
      .insert(savingsGoals)
      .values({
        name: "Fondo de emergencia",
        kind: "savings",
        scope: "common",
        // 3-6 months of expenses: $15.000 target by end of the current year.
        targetCents: 1500000,
        deadline: isoDay(year, 12, 31, 31),
        // 36,5% TNA nominal: exercises the DAILY simple accrual engine.
        annualRateBp: 3650,
        accrualMode: "simple",
      })
      .returning();
    await db.insert(savingsContributions).values([
      { goalId: goal.id, memberId: userId("andres"), kind: "deposit", amountCents: 300000, date: day(1) },
      { goalId: goal.id, memberId: userId("maria"), kind: "deposit", amountCents: 150000, date: day(10) },
    ]);
  }
  if (!goalRows.some((g) => g.name === "Plazo fijo")) {
    const [goal] = await db
      .insert(savingsGoals)
      .values({
        name: "Plazo fijo",
        kind: "investment",
        scope: "common",
        currentValueCents: 165000,
        valueUpdatedAt: now,
        institution: "Banco Nación",
        // 70% annual: investments are manual valuation only, so this rate is
        // dormant — the compound mode rides along for completeness.
        annualRateBp: 7000,
        accrualMode: "compound",
      })
      .returning();
    await db.insert(savingsContributions).values([
      { goalId: goal.id, memberId: userId("andres"), kind: "deposit", amountCents: 200000, date: day(3) },
      { goalId: goal.id, memberId: userId("maria"), kind: "withdrawal", amountCents: 50000, date: day(12) },
    ]);
  }

  // --- Demo loans + payments (demo only; no unique key → check by name) ---
  // Payments reduce the debt and MIRROR an expense (category "Pago de
  // préstamos"); the mirrors ride along in the same guard block.
  const loanRows = await db.select().from(loans);
  if (!loanRows.some((l) => l.name === "Visa Banco Nación")) {
    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa Banco Nación",
        kind: "credit_card",
        entity: "Visa Banco Nación",
        scope: "common",
        principalCents: 85_000_000, // $850.000
        annualRateBp: 4500, // 45% TNA
      })
      .returning();
    for (const payment of [
      { memberId: userId("andres"), amountCents: 5_000_000, date: day(5) }, // $50.000
      { memberId: userId("maria"), amountCents: 3_000_000, date: day(12) }, // $30.000
    ]) {
      const [row] = await db
        .insert(loanPayments)
        .values({ loanId: card.id, ...payment, kind: "payment" })
        .returning();
      await db.insert(transactions).values({
        date: payment.date,
        amountCents: payment.amountCents,
        type: "expense",
        categoryId: categoryId("Pago de préstamos"),
        memberId: payment.memberId,
        scope: card.scope,
        note: "Pago Visa Banco Nación",
        loanPaymentId: row.id,
      });
    }
  }
  if (!loanRows.some((l) => l.name === "Hipoteca casa")) {
    await db.insert(loans).values({
      name: "Hipoteca casa",
      kind: "mortgage",
      entity: "Banco Hipotecario",
      scope: "common",
      principalCents: 1_200_000_000, // $12.000.000
      // No rate: the demo also covers the rateless path (no accrual).
    });
  }
}

async function seed(): Promise<void> {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to seed. See .env.example.");
  }

  // dep: postgres — Postgres wire driver for the seed CLI; single package,
  // zero transitive deps, native ESM. Rejected `pg` (more transitive deps, CJS).
  const client = postgres(config.DATABASE_URL, {
    // Same Supavisor constraint as the app client (src/db/index.ts): the
    // transaction-mode pooler breaks named prepared statements.
    prepare: false,
  });
  const db = drizzle(client);

  try {
    await seedDatabase(db, config);
    console.log(
      config.SEED_DEMO_DATA
        ? "Seed completed (demo data included)."
        : "Seed completed (production mode: admin + categories only).",
    );
  } finally {
    await client.end();
  }
}

// Run only when executed directly (`npm run db:seed`); importing this module
// (tests) must not open connections or mutate databases.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
