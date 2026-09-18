/**
 * Seed script — `npm run db:seed`.
 *
 * Idempotent-ish: rows are looked up by natural keys before inserting
 * (username, category name, envelope/group name, month+category), so re-runs
 * skip what already exists instead of duplicating it.
 *
 * `SEED_DEMO_DATA=false` turns this into a production bootstrap: categories
 * and the admin user only — no demo members, envelopes, group, transactions
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
import { budgets, categories, envelopes, expenseGroups, transactions, users } from "./schema.ts";

/** Any Postgres drizzle database — postgres-js in the CLI, PGlite in tests. */
type SeedDb = PgDatabase<PgQueryResultHKT>;

/** ISO date (YYYY-MM-DD) for the given day of the current month. */
function isoDay(year: number, month: number, day: number, lastDay: number): string {
  const clamped = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

export async function seedDatabase(db: SeedDb, config: AppConfig): Promise<void> {
  // --- Admin user (always; username is unique; conflicts skipped) ---
  const passwordHash = await hash(config.SEED_ADMIN_PASSWORD);
  await db
    .insert(users)
    .values({ username: "admin", passwordHash, name: "Admin", role: "admin" as const })
    .onConflictDoNothing();

  // --- Categories (always; name is unique; conflicts skipped) ---
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
  ] as const;
  const incomeCategories = [
    ["Sueldo", "#22c55e"],
    ["Otros ingresos", "#4ade80"],
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

  // --- Envelopes (no unique constraint on name → check by name) ---
  const envelopeRows = await db.select().from(envelopes);
  if (!envelopeRows.some((e) => e.name === "Supermercado")) {
    await db.insert(envelopes).values({
      name: "Supermercado",
      scope: "common",
      monthlyAmountCents: 300000,
    });
  }
  if (!envelopeRows.some((e) => e.name === "Plata de Andrés")) {
    await db.insert(envelopes).values({
      name: "Plata de Andrés",
      scope: "individual",
      memberId: userId("andres"),
      monthlyAmountCents: 150000,
    });
  }
  const envelopeRowsAfter = await db.select().from(envelopes);
  const envelopeId = (name: string): string => {
    const found = envelopeRowsAfter.find((e) => e.name === name);
    if (!found) throw new Error(`Seed envelope "${name}" missing after insert`);
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
        envelopeId: envelopeId("Supermercado"),
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
        envelopeId: envelopeId("Supermercado"),
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
}

async function seed(): Promise<void> {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to seed. See .env.example.");
  }

  // dep: postgres — Postgres wire driver for the seed CLI; single package,
  // zero transitive deps, native ESM. Rejected `pg` (more transitive deps, CJS).
  const client = postgres(config.DATABASE_URL);
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
