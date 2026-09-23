import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { savingsContributions, savingsGoals, users } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { catchUpInterest } from "@/features/savings/accrual";
import { getPatrimony, listGoals } from "@/features/savings/service";

/**
 * Daily accrual engine suite (R3): deterministic fixtures with injectable
 * `now`. Complete app-timezone days, one 'Interés diario' row per day:
 * - compound: daily = (1+r)^(1/365) − 1 on the RUNNING balance (TEA),
 * - simple: daily = r/365 on the PRINCIPAL only (TNA; interest never earns).
 */

const DAILY_NOTE = "Interés diario";

/** Daily fraction implied by a 12% EFFECTIVE annual rate. */
const COMPOUND_DAILY = Math.pow(1.12, 1 / 365) - 1;
/** Daily fraction of a 12% NOMINAL annual rate. */
const SIMPLE_DAILY = 0.12 / 365;

async function insertGoal(
  db: PgliteDatabase,
  values: Partial<typeof savingsGoals.$inferInsert> & { name: string },
) {
  const [goal] = await db
    .insert(savingsGoals)
    .values({ kind: "savings", scope: "common", ...values })
    .returning();
  return goal;
}

async function interestRows(db: PgliteDatabase, goalId: string) {
  return db
    .select()
    .from(savingsContributions)
    .where(eq(savingsContributions.goalId, goalId))
    .orderBy(asc(savingsContributions.date));
}

describe("catchUpInterest — daily engine (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let depositorId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [user] = await db
      .insert(users)
      .values({ username: "saver", passwordHash: "x", name: "Saver" })
      .returning();
    depositorId = user.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("compound mode: TEA applied to the running balance, interest earns interest", async () => {
    // $100.000 at 12% TEA: daily ≈ 3105 → 3106 → 3107 cents (growing).
    const goal = await insertGoal(db, {
      name: "Compuesta",
      annualRateBp: 1200,
      accrualMode: "compound",
      createdAt: new Date("2026-08-15T12:00:00Z"),
    });
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 10_000_000,
      date: "2026-08-20",
    });

    // now = 2026-08-24 12:00 UTC → app-tz today 08-24 → accrues 08-16..08-23.
    // The deposit earns from 08-21: 3 earning days.
    const inserted = await catchUpInterest(appDb, goal.id, new Date("2026-08-24T12:00:00Z"));
    expect(inserted).toBe(3);

    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    // Day 1 follows the exact formula; later days grow because interest
    // earns interest (each day = round(previous integer balance × daily)).
    expect(rows[0].amountCents).toBe(Math.round(10_000_000 * COMPOUND_DAILY));
    expect(rows.map((r) => r.amountCents)).toEqual([3105, 3106, 3107]);
    expect(rows.every((r) => r.memberId === null)).toBe(true);
    expect(rows.every((r) => r.note === DAILY_NOTE)).toBe(true);
  });

  it("simple mode: TNA/365 linear on the principal, interest never earns", async () => {
    const goal = await insertGoal(db, {
      name: "Simple",
      annualRateBp: 1200,
      accrualMode: "simple",
      createdAt: new Date("2026-08-15T12:00:00Z"),
    });
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 100_000,
      date: "2026-08-20",
    });

    const inserted = await catchUpInterest(appDb, goal.id, new Date("2026-08-24T12:00:00Z"));
    expect(inserted).toBe(3);

    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    // 100000 × 0.12/365 = 32.88 → 33 every day (balance growth does NOT compound).
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-08-21", Math.round(100_000 * SIMPLE_DAILY)],
      ["2026-08-22", Math.round(100_000 * SIMPLE_DAILY)],
      ["2026-08-23", Math.round(100_000 * SIMPLE_DAILY)],
    ]);
  });

  it("a mid-stream deposit changes the earning base from the NEXT day", async () => {
    const goal = await insertGoal(db, {
      name: "Flujo",
      annualRateBp: 1200,
      accrualMode: "simple",
      createdAt: new Date("2026-08-01T12:00:00Z"),
    });
    await db.insert(savingsContributions).values([
      { goalId: goal.id, memberId: depositorId, kind: "deposit", amountCents: 100_000, date: "2026-08-01" },
      { goalId: goal.id, memberId: depositorId, kind: "deposit", amountCents: 100_000, date: "2026-08-10" },
    ]);

    // Accrues 08-02..08-11: nine days at 100000, then 08-11 at 200000.
    await catchUpInterest(appDb, goal.id, new Date("2026-08-12T12:00:00Z"));
    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    const amounts = rows.map((r) => r.amountCents);
    expect(amounts.filter((cents) => cents === Math.round(100_000 * SIMPLE_DAILY))).toHaveLength(9);
    expect(amounts.at(-1)).toBe(Math.round(200_000 * SIMPLE_DAILY));
  });

  it("simple mode: a withdrawal above the principal eats interest and floors at 0", async () => {
    const goal = await insertGoal(db, {
      name: "Retiro grande",
      annualRateBp: 1200,
      accrualMode: "simple",
      createdAt: new Date("2026-08-01T12:00:00Z"),
    });
    await db.insert(savingsContributions).values([
      { goalId: goal.id, memberId: depositorId, kind: "deposit", amountCents: 50_000, date: "2026-08-01" },
      { goalId: goal.id, memberId: depositorId, kind: "withdrawal", amountCents: 60_000, date: "2026-08-05" },
    ]);

    // Days 08-02..08-05: earn while the principal is positive, then stop.
    await catchUpInterest(appDb, goal.id, new Date("2026-08-08T12:00:00Z"));
    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    // 08-02..08-05 all have principal 50000 available (withdrawal dated 08-05
    // enters the base on 08-06): four 16-cent days, then nothing.
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-08-02", Math.round(50_000 * SIMPLE_DAILY)],
      ["2026-08-03", Math.round(50_000 * SIMPLE_DAILY)],
      ["2026-08-04", Math.round(50_000 * SIMPLE_DAILY)],
      ["2026-08-05", Math.round(50_000 * SIMPLE_DAILY)],
    ]);
  });

  it("is idempotent: re-running with the same now inserts nothing", async () => {
    const goal = await insertGoal(db, {
      name: "Idempotente",
      annualRateBp: 1200,
      accrualMode: "simple",
      createdAt: new Date("2026-08-15T12:00:00Z"),
    });
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 100_000,
      date: "2026-08-20",
    });
    const now = new Date("2026-08-24T12:00:00Z");
    await catchUpInterest(appDb, goal.id, now);

    const second = await catchUpInterest(appDb, goal.id, now);
    expect(second).toBe(0);
    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(3);
  });

  it("continues from the last interest row and keeps old monthly rows", async () => {
    const goal = await insertGoal(db, {
      name: "Herencia mensual",
      annualRateBp: 1200,
      accrualMode: "simple",
      createdAt: new Date("2026-07-15T12:00:00Z"),
    });
    await db.insert(savingsContributions).values([
      { goalId: goal.id, memberId: depositorId, kind: "deposit", amountCents: 100_000, date: "2026-07-20" },
      // Historical monthly row (old engine semantics) dated 2026-08-01.
      { goalId: goal.id, memberId: null, kind: "interest", amountCents: 1000, date: "2026-08-01", note: "Interés 12% TNA" },
    ]);

    await catchUpInterest(appDb, goal.id, new Date("2026-08-04T12:00:00Z"));
    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    // Daily rows resume the day AFTER the last interest row; the monthly row stays.
    expect(rows.map((r) => [r.date, r.note, r.amountCents])).toEqual([
      ["2026-08-01", "Interés 12% TNA", 1000],
      ["2026-08-02", DAILY_NOTE, Math.round(100_000 * SIMPLE_DAILY)],
      ["2026-08-03", DAILY_NOTE, Math.round(100_000 * SIMPLE_DAILY)],
    ]);
  });

  it("uses value_updated_at as a rebase and no-ops without complete days", async () => {
    const rebased = await insertGoal(db, {
      name: "Rebazada",
      annualRateBp: 1200,
      accrualMode: "compound",
      createdAt: new Date("2026-01-10T12:00:00Z"),
      valueUpdatedAt: new Date("2026-06-20T12:00:00Z"),
    });
    await db.insert(savingsContributions).values({
      goalId: rebased.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 100_000,
      date: "2026-02-15",
    });

    // now = 2026-06-24 (app tz) → accrues 06-21..06-23 only: nothing before
    // the rebase day is re-earned.
    const inserted = await catchUpInterest(appDb, rebased.id, new Date("2026-06-24T12:00:00Z"));
    expect(inserted).toBe(3);
    const rows = (await interestRows(db, rebased.id)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => r.date)).toEqual(["2026-06-21", "2026-06-22", "2026-06-23"]);

    // Same-day as creation → zero complete days → no-op.
    const fresh = await insertGoal(db, {
      name: "Recién creada",
      annualRateBp: 500,
      accrualMode: "simple",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(await catchUpInterest(appDb, fresh.id, new Date("2026-05-01T10:00:00Z"))).toBe(0);

    // Ghost id, rateless goal and investments: quiet no-ops.
    expect(
      await catchUpInterest(appDb, "00000000-0000-4000-8000-000000000000", new Date("2026-11-05")),
    ).toBe(0);
    const plain = await insertGoal(db, { name: "Sin tasa" });
    expect(await catchUpInterest(appDb, plain.id, new Date("2026-11-05"))).toBe(0);
    const stock = await insertGoal(db, {
      name: "Acciones",
      kind: "investment",
      annualRateBp: 1200,
      accrualMode: "compound",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await catchUpInterest(appDb, stock.id, new Date("2026-11-05"))).toBe(0);
  });

  it("runs lazily from read paths: listGoals and getPatrimony trigger catch-up", async () => {
    const goal = await insertGoal(db, {
      name: "Lectura",
      annualRateBp: 1200,
      accrualMode: "compound",
      createdAt: new Date("2026-08-15T12:00:00Z"),
    });
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 100_000,
      date: "2026-08-20",
    });

    // No catchUpInterest call here — the read path must do it.
    const goals = await listGoals(appDb);
    const listed = goals.find((g) => g.name === "Lectura")!;
    const rows = await interestRows(db, goal.id);
    const interest = rows.filter((r) => r.kind === "interest");
    expect(interest.length).toBeGreaterThan(0);
    expect(listed.interestTotalCents).toBe(
      interest.reduce((sum, r) => sum + r.amountCents, 0),
    );

    const patrimony = await getPatrimony(appDb);
    const patrimonyGoal = patrimony.goals.find((g) => g.name === "Lectura")!;
    expect(patrimonyGoal.valueCents).toBe(listed.netCents);
    expect(patrimonyGoal.valueCents).toBeGreaterThan(100_000);
  });
});
