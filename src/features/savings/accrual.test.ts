import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { savingsContributions, savingsGoals, users } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { catchUpInterest } from "@/features/savings/accrual";
import { getPatrimony, listGoals } from "@/features/savings/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Accrual engine suite (R3): deterministic fixtures with injectable `now`.
 * Exact-cent monthly compounding: interest = round(balance × bp / 12 / 10000)
 * per elapsed whole month, dated the month start.
 */

interface Fixture {
  goalId: string;
}

/** Goal created 2026-08-15 at 12% TNA, $1.000 deposited on 2026-08-20. */
async function seedCompoundFixture(
  db: PgliteDatabase,
  depositorId: string,
  name = "Compuesta",
): Promise<Fixture> {
  const [goal] = await db
    .insert(savingsGoals)
    .values({
      name,
      kind: "savings",
      scope: "common",
      annualRateBp: 1200,
      createdAt: new Date("2026-08-15T12:00:00Z"),
    })
    .returning();
  await db.insert(savingsContributions).values({
    goalId: goal.id,
    memberId: depositorId,
    kind: "deposit",
    amountCents: 100_000,
    date: "2026-08-20",
  });
  return { goalId: goal.id };
}

async function interestRows(db: PgliteDatabase, goalId: string) {
  return db
    .select()
    .from(savingsContributions)
    .where(eq(savingsContributions.goalId, goalId))
    .orderBy(asc(savingsContributions.date));
}

describe("catchUpInterest (integration on PGlite)", () => {
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

  it("accrues 3 elapsed months with exact-cent compounding", async () => {
    const { goalId } = await seedCompoundFixture(db, depositorId);

    const inserted = await catchUpInterest(appDb, goalId, new Date("2026-11-05T10:00:00Z"));
    expect(inserted).toBe(3);

    const rows = (await interestRows(db, goalId)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-09-01", 1000], // 100000 × 1%
      ["2026-10-01", 1010], // 101000 × 1%
      ["2026-11-01", 1020], // 102010 × 1% → 1020.1 rounds to 1020
    ]);
    expect(rows.every((r) => r.memberId === null)).toBe(true);
    expect(rows[0].note).toBe("Interés 12% TNA");
  });

  it("is idempotent: re-running with the same now inserts nothing", async () => {
    const { goalId } = await seedCompoundFixture(db, depositorId);
    const now = new Date("2026-11-05T10:00:00Z");
    await catchUpInterest(appDb, goalId, now);

    const second = await catchUpInterest(appDb, goalId, now);
    expect(second).toBe(0);
    const rows = (await interestRows(db, goalId)).filter((r) => r.kind === "interest");
    expect(rows).toHaveLength(3);
  });

  it("no-ops on partial months, same month, unknown goals and rateless goals", async () => {
    const { goalId } = await seedCompoundFixture(db, depositorId);

    // Same month as creation → zero elapsed whole months.
    expect(await catchUpInterest(appDb, goalId, new Date("2026-08-31T23:00:00Z"))).toBe(0);

    // Zero-balance rate-bearing goal: months pass, balance 0 → no rows.
    const [empty] = await db
      .insert(savingsGoals)
      .values({
        name: "Vacía",
        kind: "savings",
        scope: "common",
        annualRateBp: 500,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      })
      .returning();
    expect(await catchUpInterest(appDb, empty.id, new Date("2026-08-01T00:00:00Z"))).toBe(0);
    expect(await interestRows(db, empty.id)).toHaveLength(0);

    // Ghost id and rateless goal: quiet no-ops.
    expect(
      await catchUpInterest(appDb, "00000000-0000-4000-8000-000000000000", new Date("2026-11-05")),
    ).toBe(0);
    const [plain] = await db
      .insert(savingsGoals)
      .values({ name: "Sin tasa", kind: "savings", scope: "common" })
      .returning();
    expect(await catchUpInterest(appDb, plain.id, new Date("2026-11-05"))).toBe(0);
  });

  it("uses value_updated_at as an accrual base when set", async () => {
    const [goal] = await db
      .insert(savingsGoals)
      .values({
        name: "Rebazada",
        kind: "investment",
        scope: "common",
        annualRateBp: 1200,
        currentValueCents: 100_000,
        createdAt: new Date("2026-01-10T00:00:00Z"),
        valueUpdatedAt: new Date("2026-06-20T00:00:00Z"),
      })
      .returning();
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 100_000,
      date: "2026-02-15",
    });

    // Months Jan..Jun are before the rebase; only Jul and Aug accrue.
    const inserted = await catchUpInterest(appDb, goal.id, new Date("2026-08-15T00:00:00Z"));
    expect(inserted).toBe(2);
    const rows = (await interestRows(db, goal.id)).filter((r) => r.kind === "interest");
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-07-01", 1000],
      ["2026-08-01", 1010],
    ]);
  });

  it("runs lazily from read paths: listGoals and getPatrimony trigger catch-up", async () => {
    await seedCompoundFixture(db, depositorId, "CompuestaLectura");

    // No catchUpInterest call here — the read path must do it.
    const goals = await listGoals(appDb);
    const goal = goals.find((g) => g.name === "CompuestaLectura")!;
    // Real now: createdAt 2026-08 → every month start after August that has
    // already passed accrues (one per elapsed month, ≥ 1 since Sep 2026).
    const rows = await interestRows(db, goal.id);
    const interest = rows.filter((r) => r.kind === "interest");
    expect(interest.length).toBeGreaterThan(0);
    expect(goal.interestTotalCents).toBe(
      interest.reduce((sum, r) => sum + r.amountCents, 0),
    );

    const patrimony = await getPatrimony(appDb);
    const patrimonyGoal = patrimony.goals.find((g) => g.name === "CompuestaLectura")!;
    expect(patrimonyGoal.valueCents).toBe(goal.netCents);
    expect(patrimonyGoal.valueCents).toBeGreaterThan(100_000);
  });

  it("credits true-up interest and rebases accrual (admin valuation)", async () => {
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

    const [goal] = await db
      .insert(savingsGoals)
      .values({
        name: "TrueUp",
        kind: "investment",
        scope: "common",
        annualRateBp: 1200,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      memberId: depositorId,
      kind: "deposit",
      amountCents: 20_000,
      date: "2026-09-05",
    });

    // Rebase to $215: +$1.50 visible as ONE "Ajuste de valoración" row.
    const { updateGoalValue } = await import("@/features/savings/service");
    expect(await updateGoalValue(appDb, user, goal.id, "215")).toEqual({ ok: true });

    let rows = await interestRows(db, goal.id);
    const trueUp = rows.find((r) => r.note === "Ajuste de valoración")!;
    expect(trueUp.kind).toBe("interest");
    expect(trueUp.memberId).toBeNull();
    expect(trueUp.amountCents).toBe(1500);

    // Ledger balance now equals the stated value; net = 21500.
    const goals = await listGoals(appDb);
    expect(goals.find((g) => g.id === goal.id)).toMatchObject({ netCents: 21_500 });

    // The true-up row (dated this month) rebases accrual: next months accrue
    // on the rebased balance.
    await catchUpInterest(appDb, goal.id, new Date("2026-11-18T00:00:00Z"));
    rows = await interestRows(db, goal.id);
    const monthly = rows.filter((r) => r.note === "Interés 12% TNA");
    expect(monthly.map((r) => [r.date, r.amountCents])).toEqual([
      ["2026-10-01", 215], // 21500 × 1%
      ["2026-11-01", 217], // 21715 × 1% → 217.15 → 217
    ]);

    // Losing valuation on the same day REPLACES the day's adjustment: the
    // ledger keeps ONE net entry converging to the latest stated value.
    expect(await updateGoalValue(appDb, user, goal.id, "210")).toEqual({ ok: true });
    rows = await interestRows(db, goal.id);
    const ajustes = rows.filter((r) => r.note === "Ajuste de valoración");
    expect(ajustes).toHaveLength(1);
    // Balance without the replaced +1500: 20000 + 215 + 217 = 20432 → +568.
    expect(ajustes[0].amountCents).toBe(568);
    const goalsAfter = await listGoals(appDb);
    expect(goalsAfter.find((g) => g.id === goal.id)).toMatchObject({ netCents: 21_000 });

    // A valuation BELOW the real balance writes a NEGATIVE interest entry.
    // Same-day replace: the ajuste converges to 19000 − 20432 = −1432.
    expect(await updateGoalValue(appDb, user, goal.id, "190")).toEqual({ ok: true });
    rows = await interestRows(db, goal.id);
    const ajustesAfterLoss = rows.filter((r) => r.note === "Ajuste de valoración");
    expect(ajustesAfterLoss).toHaveLength(1);
    expect(ajustesAfterLoss[0].amountCents).toBe(-1_432);
    const goalsAfterLoss = await listGoals(appDb);
    expect(goalsAfterLoss.find((g) => g.id === goal.id)).toMatchObject({ netCents: 19_000 });
  });
});
