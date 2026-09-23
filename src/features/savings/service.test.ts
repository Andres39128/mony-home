import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
import {
  addContribution,
  computeGoalProgress,
  computeInvestmentReturn,
  computeNetCents,
  contributionSchema,
  createGoal,
  getPatrimony,
  goalSchema,
  investmentValueCents,
  listContributions,
  listGoals,
  listPendingRateReviews,
  markRateReviewed,
  monthsUntilDeadline,
  removeGoal,
  toggleGoalActive,
  updateGoal,
  updateGoalValue,
  type ContributionInput,
  type GoalInput,
} from "@/features/savings/service";
import { transactionTotals } from "@/features/transactions/service";
import { todayIso } from "@/lib/date";
import type { SessionUser } from "@/lib/auth";

/**
 * Savings service suite: goal CRUD + scope CHECK, contribution net math in
 * exact cents, member pinning, mirror transactions (R1), investment
 * valuation/return, patrimony aggregation and the full admin/member
 * authorization matrix — against in-memory Postgres with the real migrations.
 */

const savingsInput: GoalInput = {
  name: "Fondo de emergencia",
  kind: "savings",
  scope: "common",
  memberId: "",
  target: "1500",
  deadline: "",
  currentValue: "",
  institution: "",
  annualRate: "",
  accrualMode: "",
};

const investmentInput: GoalInput = {
  name: "Plazo fijo",
  kind: "investment",
  scope: "common",
  memberId: "",
  target: "",
  deadline: "",
  currentValue: "",
  institution: "",
  annualRate: "",
  accrualMode: "",
};

/** Empty date mirrors the zod transform: "" → today. */
const deposit = (amount: string, date = "", memberId = ""): ContributionInput => ({
  amount,
  kind: "deposit",
  date: date || todayIso(),
  note: "",
  memberId,
});

describe("savings helpers (pure)", () => {
  it("computes net, goal progress and deadline months", () => {
    expect(computeNetCents(150000, 50000)).toBe(100000);
    expect(computeGoalProgress(100000, null)).toBeNull();
    expect(computeGoalProgress(750000, 1000000)).toMatchObject({
      pct: 75,
      remainingCents: 250000,
      status: "warn",
    });
    expect(computeGoalProgress(1000000, 1000000)).toMatchObject({ pct: 100, status: "over" });
    // Month-granularity countdown: negative = overdue, 0 = current month.
    expect(monthsUntilDeadline(null)).toBeNull();
    expect(monthsUntilDeadline("2027-09-20", "2026-09-18")).toBe(12);
    expect(monthsUntilDeadline("2026-09-30", "2026-09-18")).toBe(0);
    expect(monthsUntilDeadline("2026-08-31", "2026-09-18")).toBe(-1);
  });

  it("computes investment return with div-zero and never-updated fallback", () => {
    expect(computeInvestmentReturn(100000, 110000)).toBe(10);
    expect(computeInvestmentReturn(100000, 90000)).toBe(-10);
    // Never valued → falls back to net invested → 0%.
    expect(computeInvestmentReturn(100000, null)).toBe(0);
    // No money invested → division by zero → 0%.
    expect(computeInvestmentReturn(0, 50000)).toBe(0);
    expect(investmentValueCents(100000, null)).toBe(100000);
    expect(investmentValueCents(100000, 130000)).toBe(130000);
  });
});

/** Mirror categories (R1): contribute() writes movements under these names. */
async function seedMirrorCategories(db: PgliteDatabase): Promise<void> {
  await db.insert(categories).values([
    { name: "Ahorro e inversión", kind: "expense" },
    { name: "Recupero de ahorro", kind: "income" },
  ]);
}

describe("savings goals CRUD (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    await seedMirrorCategories(db);
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

  it("creates goals with AR-formatted target and optional fields", async () => {
    expect(
      await createGoal(appDb, admin, { ...savingsInput, target: "1.500,00", deadline: "2027-06-30" }),
    ).toEqual({ ok: true });
    expect(
      await createGoal(appDb, admin, { ...investmentInput, currentValue: "165.000,50" }),
    ).toEqual({ ok: true });

    const goals = await listGoals(appDb);
    // Active savings first, then investments, then by name.
    expect(goals.map((g) => g.name)).toEqual(["Fondo de emergencia", "Plazo fijo"]);
    const savings = goals.find((g) => g.kind === "savings");
    expect(savings).toMatchObject({
      targetCents: 150_000,
      deadline: "2027-06-30",
      currentValueCents: null,
      netCents: 0,
      contributionCount: 0,
    });
    const investment = goals.find((g) => g.kind === "investment");
    expect(investment).toMatchObject({
      targetCents: null,
      deadline: null,
      currentValueCents: 16_500_050,
      valueUpdatedAt: expect.any(Date),
    });
  });

  it("mirrors the scope CHECK at the zod level", async () => {
    const parsed = goalSchema.safeParse({ ...savingsInput, scope: "individual" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.find((i) => i.path[0] === "memberId")?.message).toBe(
      "Las bolsas individuales requieren un integrante.",
    );

    const withMember = goalSchema.safeParse({ ...savingsInput, memberId });
    expect(withMember.success).toBe(false);
  });

  it("rejects kind-specific fields with friendly typed errors", async () => {
    const parsed = goalSchema.safeParse({ ...savingsInput, currentValue: "100" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === "currentValue")).toBe(true);
    }

    const result = await createGoal(appDb, admin, { ...savingsInput, currentValue: "100" });
    expect(result).toEqual({ ok: false, error: "invalid_current_value" });

    // Investments reject savings-only fields (target / deadline).
    expect(
      await createGoal(appDb, admin, { ...investmentInput, target: "500" }),
    ).toEqual({ ok: false, error: "invalid_target" });
    expect(
      await createGoal(appDb, admin, { ...investmentInput, deadline: "2027-01-01" }),
    ).toEqual({ ok: false, error: "invalid_target" });
  });

  it("updates name, scope, member, target and valuation", async () => {
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Fondo de emergencia"));

    expect(
      await updateGoal(appDb, admin, row.id, {
        ...savingsInput,
        name: "Emergencias",
        scope: "individual",
        memberId,
        target: "2.000,00",
      }),
    ).toEqual({ ok: true });
    const [after] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(after).toMatchObject({
      name: "Emergencias",
      scope: "individual",
      memberId,
      targetCents: 200_000,
    });

    // Converting to an investment clears savings-only fields.
    expect(
      await updateGoal(appDb, admin, row.id, { ...investmentInput, name: "Emergencias" }),
    ).toEqual({ ok: true });
    const [converted] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(converted).toMatchObject({ kind: "investment", targetCents: null, deadline: null });
  });

  it("reports typed errors for unknown ids and invalid amounts", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await updateGoal(appDb, admin, ghostId, savingsInput)).toEqual({
      ok: false,
      error: "goal_not_found",
    });
    expect(await toggleGoalActive(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "goal_not_found",
    });
    expect(await removeGoal(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "goal_not_found",
    });
    expect(await updateGoalValue(appDb, admin, ghostId, "100")).toEqual({
      ok: false,
      error: "goal_not_found",
    });
    expect(await updateGoal(appDb, admin, savingsInput.name, { ...savingsInput, target: "x" })).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("deleting a goal with contributions fails with a typed restrict error", async () => {
    await createGoal(appDb, admin, { ...savingsInput, name: "ConAportes" });
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "ConAportes"));
    expect(await addContribution(appDb, admin, row.id, deposit("100"))).toEqual({ ok: true });

    const result = await removeGoal(appDb, admin, row.id);
    expect(result).toEqual({ ok: false, error: "has_contributions" });
    const stillThere = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(stillThere).toHaveLength(1);
  });

  it("deleting a goal without contributions succeeds; toggling flips is_active", async () => {
    await createGoal(appDb, admin, { ...savingsInput, name: "Limpia" });
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Limpia"));

    expect(await toggleGoalActive(appDb, admin, row.id)).toEqual({ ok: true });
    let after = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(after[0].isActive).toBe(false);

    expect(await removeGoal(appDb, admin, row.id)).toEqual({ ok: true });
    after = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(after).toHaveLength(0);
  });

  it("enforces the admin/member authorization matrix at service level", async () => {
    // Members can never manage goals or valuations.
    expect(await createGoal(appDb, member, savingsInput)).toEqual({ ok: false, error: "forbidden" });
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Emergencias"));
    expect(await updateGoal(appDb, member, row.id, savingsInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await toggleGoalActive(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await removeGoal(appDb, member, row.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await updateGoalValue(appDb, member, row.id, "100")).toEqual({
      ok: false,
      error: "forbidden",
    });

    // Contributions are open to members, but PINNED to themselves.
    expect(await addContribution(appDb, member, row.id, deposit("50"))).toEqual({ ok: true });
    expect(await addContribution(appDb, member, row.id, deposit("50", "", admin.id))).toEqual({
      ok: false,
      error: "forbidden",
    });
    // Admins may attribute to any member.
    expect(await addContribution(appDb, admin, row.id, deposit("70", "", memberId))).toEqual({
      ok: true,
    });
  });

  it("rejects contributions to unknown or inactive goals and bad amounts", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await addContribution(appDb, admin, ghostId, deposit("100"))).toEqual({
      ok: false,
      error: "goal_not_found",
    });

    await createGoal(appDb, admin, { ...savingsInput, name: "Pausada" });
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Pausada"));
    await toggleGoalActive(appDb, admin, row.id);
    expect(await addContribution(appDb, member, row.id, deposit("100"))).toEqual({
      ok: false,
      error: "goal_inactive",
    });

    const parsed = contributionSchema.safeParse({ ...deposit("100"), amount: "" });
    expect(parsed.success).toBe(false);
    expect(await addContribution(appDb, member, row.id, deposit("-5"))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(await addContribution(appDb, member, row.id, deposit("abc"))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
  });

  it("lists contributions newest first with member attribution", async () => {
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Emergencias"));
    await db.insert(savingsContributions).values([
      { goalId: row.id, memberId, kind: "withdrawal", amountCents: 1234, date: "2026-05-01" },
      { goalId: row.id, memberId, kind: "deposit", amountCents: 2345, date: "2026-05-02" },
    ]);

    const list = await listContributions(appDb, row.id);
    expect(list).toHaveLength(4);
    expect(list[0]?.date).toBe(todayIso());
    expect(list.slice(-2).map((c) => [c.date, c.memberName, c.amountCents, c.kind])).toEqual([
      ["2026-05-02", "Mate", 2345, "deposit"],
      ["2026-05-01", "Mate", 1234, "withdrawal"],
    ]);
  });

  it("accumulates net across months (month-agnostic) in exact cents", async () => {
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Emergencias"));
    // Past months count too — unlike budget monthly progress.
    await db.insert(savingsContributions).values([
      { goalId: row.id, memberId, kind: "deposit", amountCents: 100_50, date: "2025-01-15" },
    ]);

    const goals = await listGoals(appDb);
    const goal = goals.find((g) => g.id === row.id);
    // 5000 + 7000 - 1234 + 2345 + 10050 = 23161 exact cents.
    expect(goal).toMatchObject({ netCents: 23_161, contributionCount: 5 });
  });

  it("defaults accrual mode to simple, honors compound and stamps the review month", async () => {
    // Rate without an explicit mode → 'simple' + review month stamped.
    expect(
      await createGoal(appDb, admin, {
        ...savingsInput,
        name: "ModoDefault",
        annualRate: "35,5",
      }),
    ).toEqual({ ok: true });
    // Explicit compound + rate → 'compound'.
    expect(
      await createGoal(appDb, admin, {
        ...savingsInput,
        name: "ModoCompuesto",
        annualRate: "35,5",
        accrualMode: "compound",
      }),
    ).toEqual({ ok: true });
    // Rateless goal → mode and review month null.
    expect(await createGoal(appDb, admin, { ...savingsInput, name: "ModoNull" })).toEqual({
      ok: true,
    });

    const goals = await listGoals(appDb);
    const currentMonthStart = `${todayIso().slice(0, 7)}-01`;
    expect(goals.find((g) => g.name === "ModoDefault")).toMatchObject({
      accrualMode: "simple",
      rateReviewedMonth: currentMonthStart,
    });
    expect(goals.find((g) => g.name === "ModoCompuesto")).toMatchObject({
      accrualMode: "compound",
      rateReviewedMonth: currentMonthStart,
    });
    expect(goals.find((g) => g.name === "ModoNull")).toMatchObject({
      accrualMode: null,
      rateReviewedMonth: null,
    });

    // Removing the rate clears mode and review stamp.
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "ModoDefault"));
    expect(
      await updateGoal(appDb, admin, row.id, { ...savingsInput, name: "ModoDefault" }),
    ).toEqual({ ok: true });
    const [after] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(after).toMatchObject({ annualRateBp: null, accrualMode: null, rateReviewedMonth: null });
  });

  it("flags pending rate reviews and marks them reviewed (admin-only)", async () => {
    // ModoCompuesto still has a rate and (already) this month's stamp from
    // creation... so make one stale by writing last month directly.
    const [row] = await db
      .select()
      .from(savingsGoals)
      .where(eq(savingsGoals.name, "ModoCompuesto"));
    const lastMonth = (() => {
      const [y, m] = todayIso().split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 2, 1));
      return date.toISOString().slice(0, 10);
    })();
    await db
      .update(savingsGoals)
      .set({ rateReviewedMonth: lastMonth })
      .where(eq(savingsGoals.id, row.id));

    // Rateless goals never appear in the review list.
    const pendingBefore = await listPendingRateReviews(appDb);
    expect(pendingBefore.map((g) => g.name)).toEqual(["ModoCompuesto"]);
    expect(pendingBefore[0]).toMatchObject({ annualRateBp: 3550, accrualMode: "compound" });

    // Members cannot mark reviewed; admins can, and the flag clears.
    expect(await markRateReviewed(appDb, member)).toEqual({ ok: false, error: "forbidden" });
    expect(await markRateReviewed(appDb, admin)).toEqual({ ok: true });
    expect(await listPendingRateReviews(appDb)).toEqual([]);
    const [after] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, row.id));
    expect(after.rateReviewedMonth).toBe(`${todayIso().slice(0, 7)}-01`);
  });
});

describe("investments, valuation and patrimony (integration on PGlite)", () => {
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
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };

    await createGoal(appDb, admin, { ...savingsInput, name: "Ahorro", target: "1000" });
    await createGoal(appDb, admin, { ...savingsInput, name: "AhorroSinMeta", target: "" });
    await createGoal(appDb, admin, { ...investmentInput, name: "Inversión" });
    const goals = await listGoals(appDb);
    const [mate] = await db
      .insert(users)
      .values({ username: "sole", name: "Sole", passwordHash: "x", role: "member" })
      .returning();
    memberId = mate.id;

    const ahorroId = goals.find((g) => g.name === "Ahorro")!.id;
    const inversionId = goals.find((g) => g.name === "Inversión")!.id;
    await db.insert(savingsContributions).values([
      // Savings: +400.00 - 50.25 = 34975 net, across different months.
      { goalId: ahorroId, memberId: admin.id, kind: "deposit", amountCents: 40000, date: "2026-03-10" },
      { goalId: ahorroId, memberId, kind: "withdrawal", amountCents: 5025, date: "2026-08-01" },
      // Investment: net invested 20000, never valued yet.
      { goalId: inversionId, memberId: admin.id, kind: "deposit", amountCents: 20000, date: "2026-07-05" },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("values an investment (admin) and computes the rendered return", async () => {
    const goals = await listGoals(appDb);
    const inversion = goals.find((g) => g.name === "Inversión")!;
    // Never-updated value: return 0%, patrimony falls back to net invested.
    expect(inversion.currentValueCents).toBeNull();
    expect(computeInvestmentReturn(inversion.netCents, inversion.currentValueCents)).toBe(0);

    expect(await updateGoalValue(appDb, admin, inversion.id, "215")).toEqual({ ok: true });
    const [after] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, inversion.id));
    expect(after).toMatchObject({ currentValueCents: 21_500, valueUpdatedAt: expect.any(Date) });
    expect(computeInvestmentReturn(20_000, after.currentValueCents)).toBe(7.5);

    // Only investments accept a valuation.
    const ahorro = goals.find((g) => g.name === "Ahorro")!;
    expect(await updateGoalValue(appDb, admin, ahorro.id, "100")).toEqual({
      ok: false,
      error: "not_investment",
    });
    expect(await updateGoalValue(appDb, admin, inversion.id, "no-valido")).toEqual({
      ok: false,
      error: "invalid_current_value",
    });
  });

  it("aggregates patrimony: savings net + investment values with fallback", async () => {
    const patrimony = await getPatrimony(appDb);
    // Savings: 34975 (Ahorro) + 0 (AhorroSinMeta); Investments: 21500 valued.
    expect(patrimony.savingsCents).toBe(34_975);
    expect(patrimony.investmentsCents).toBe(21_500);
    expect(patrimony.totalCents).toBe(56_475);
    expect(patrimony.goals).toHaveLength(3);
    expect(patrimony.goals.find((g) => g.name === "Ahorro")).toMatchObject({
      kind: "savings",
      valueCents: 34_975,
    });
  });

  it("includes inactive goals in patrimony (deactivating does not withdraw)", async () => {
    const goals = await listGoals(appDb);
    const ahorro = goals.find((g) => g.name === "Ahorro")!;
    await toggleGoalActive(appDb, admin, ahorro.id);

    const patrimony = await getPatrimony(appDb);
    expect(patrimony.savingsCents).toBe(34_975);

    // Restore so the previous test stays reproducible if reordered.
    await toggleGoalActive(appDb, admin, ahorro.id);
  });
});

describe("mirror transactions and yield inputs (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    await seedMirrorCategories(db);
    const [row] = await db
      .insert(users)
      .values({ username: "admin2", name: "Admin2", passwordHash: "x", role: "admin" })
      .returning();
    await db
      .insert(users)
      .values({ username: "nico", name: "Nico", passwordHash: "x", role: "member" });
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };

    expect(
      await createGoal(appDb, admin, {
        ...savingsInput,
        name: "Espejo",
        institution: "Banco Nación",
        annualRate: "35,5",
      }),
    ).toEqual({ ok: true });
  });

  afterAll(async () => {
    await client.close();
  });

  const mirrorGoal = async () => {
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Espejo"));
    return row;
  };

  it("persists institution and AR-tolerant rate ('35,5' → 3550 bp)", async () => {
    const goal = await mirrorGoal();
    expect(goal).toMatchObject({ institution: "Banco Nación", annualRateBp: 3550 });

    // Zod: institution length, rate bounds and empty → null.
    expect(goalSchema.safeParse({ ...savingsInput, institution: "x".repeat(65) }).success).toBe(false);
    expect(goalSchema.safeParse({ ...savingsInput, annualRate: "1000" }).success).toBe(true);
    expect(goalSchema.safeParse({ ...savingsInput, annualRate: "1000,01" }).success).toBe(true);
    const parsed = goalSchema.parse({ ...savingsInput, annualRate: "" });
    expect(parsed.annualRate).toBe("");

    const [noRate] = await db
      .insert(savingsGoals)
      .values({ name: "SinTasa", kind: "savings", scope: "common", institution: null, annualRateBp: null })
      .returning();
    expect(noRate.annualRateBp).toBeNull();

    // Service caps: >1000% and garbage → typed invalid_rate.
    expect(
      await createGoal(appDb, admin, { ...savingsInput, name: "R1", annualRate: "1000,01" }),
    ).toEqual({ ok: false, error: "invalid_rate" });
    expect(
      await createGoal(appDb, admin, { ...savingsInput, name: "R2", annualRate: "mucho" }),
    ).toEqual({ ok: false, error: "invalid_rate" });
    expect(
      await createGoal(appDb, admin, { ...savingsInput, name: "R3", annualRate: "999,99" }),
    ).toEqual({ ok: true });
  });

  it("deposits mirror an expense; withdrawals mirror an income (R1)", async () => {
    const goal = await mirrorGoal();

    expect(await addContribution(appDb, admin, goal.id, deposit("100", "2026-09-10"))).toEqual({
      ok: true,
    });
    expect(
      await addContribution(appDb, admin, goal.id, {
        ...deposit("40", "2026-09-15"),
        kind: "withdrawal",
      }),
    ).toEqual({ ok: true });

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
      .where(eq(transactions.scope, goal.scope));

    const depositMirror = movements.find((m) => m.note === "Aporte a Espejo");
    expect(depositMirror).toMatchObject({
      type: "expense",
      amountCents: 10_000,
      date: "2026-09-10",
      scope: "common",
      memberId: admin.id,
      categoryName: "Ahorro e inversión",
    });
    const withdrawalMirror = movements.find((m) => m.note === "Retiro de Espejo");
    expect(withdrawalMirror).toMatchObject({
      type: "income",
      amountCents: 4_000,
      date: "2026-09-15",
      categoryName: "Recupero de ahorro",
    });

    // R1 proof: totals see the mirrors — Saldo dropped by the deposit.
    const totals = await transactionTotals(appDb);
    expect(totals.expenseCents).toBeGreaterThanOrEqual(10_000);
    expect(totals.balanceCents).toBe(totals.incomeCents - totals.expenseCents);
  });

  it("links every mirror to its contribution and cascades on delete", async () => {
    const goal = await mirrorGoal();
    const contributionsBefore = await db
      .select({ id: savingsContributions.id })
      .from(savingsContributions)
      .where(eq(savingsContributions.goalId, goal.id));
    const linked = await db
      .select({ contributionId: transactions.savingsContributionId })
      .from(transactions)
      .where(eq(transactions.scope, goal.scope));
    expect(new Set(linked.map((l) => l.contributionId))).toEqual(
      new Set(contributionsBefore.map((c) => c.id)),
    );

    // Interest rows never mirror: insert one directly, mirror count unchanged.
    await db.insert(savingsContributions).values({
      goalId: goal.id,
      kind: "interest",
      amountCents: 999,
      date: "2026-09-01",
    });
    const mirrorsForGoal = await db
      .select({ note: transactions.note })
      .from(transactions)
      .where(eq(transactions.scope, goal.scope));
    expect(mirrorsForGoal.map((m) => m.note).sort()).toEqual([
      "Aporte a Espejo",
      "Retiro de Espejo",
    ]);

    // Deleting a contribution removes its mirror via FK CASCADE.
    const [first] = contributionsBefore;
    await db.delete(savingsContributions).where(eq(savingsContributions.id, first.id));
    const after = await db.select().from(transactions);
    expect(
      after.filter((t) => t.savingsContributionId === first.id),
    ).toHaveLength(0);
  });
});

describe("mirror without system categories (isolated DB)", () => {
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
    expect(
      await createGoal(appDb, admin, { ...savingsInput, name: "SinCategorias" }),
    ).toEqual({ ok: true });
  });

  afterAll(async () => {
    await client.close();
  });

  it("fails typed and atomically when the mirror categories do not exist", async () => {
    const [fresh] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "SinCategorias"));

    // No categories seeded at all → contribute() cannot write the mirror.
    expect(await addContribution(appDb, admin, fresh.id, deposit("50"))).toEqual({
      ok: false,
      error: "system_category_missing",
    });
    const leftovers = await db
      .select()
      .from(savingsContributions)
      .where(eq(savingsContributions.goalId, fresh.id));
    expect(leftovers).toHaveLength(0); // nothing half-written
  });
});
