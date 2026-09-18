import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { savingsContributions, savingsGoals, users } from "@/db/schema";
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
  listContributionsByGoal,
  listGoals,
  monthsUntilDeadline,
  removeGoal,
  toggleGoalActive,
  updateGoal,
  updateGoalValue,
  type ContributionInput,
  type GoalInput,
} from "@/features/savings/service";
import { todayIso } from "@/features/transactions/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Savings service suite: goal CRUD + scope CHECK, contribution net math in
 * exact cents, member pinning, investment valuation/return, patrimony
 * aggregation and the full admin/member authorization matrix — against
 * in-memory Postgres with the real migrations.
 */

const savingsInput: GoalInput = {
  name: "Fondo de emergencia",
  kind: "savings",
  scope: "common",
  memberId: "",
  target: "1500",
  deadline: "",
  currentValue: "",
};

const investmentInput: GoalInput = {
  name: "Plazo fijo",
  kind: "investment",
  scope: "common",
  memberId: "",
  target: "",
  deadline: "",
  currentValue: "",
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
      await createGoal(appDb, admin, { ...savingsInput, target: "1.500", deadline: "2027-06-30" }),
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
      "Las metas individuales requieren un integrante.",
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
        target: "2.000",
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

    const list = await listContributionsByGoal(appDb, row.id);
    expect(list).toHaveLength(4);
    expect(list[0]?.date).toBe(todayIso());
    expect(list.slice(-2).map((c) => [c.date, c.memberName, c.amountCents, c.kind])).toEqual([
      ["2026-05-02", "Mate", 2345, "deposit"],
      ["2026-05-01", "Mate", 1234, "withdrawal"],
    ]);
  });

  it("accumulates net across months (month-agnostic) in exact cents", async () => {
    const [row] = await db.select().from(savingsGoals).where(eq(savingsGoals.name, "Emergencias"));
    // Past months count too — unlike bolsas monthly progress.
    await db.insert(savingsContributions).values([
      { goalId: row.id, memberId, kind: "deposit", amountCents: 100_50, date: "2025-01-15" },
    ]);

    const goals = await listGoals(appDb);
    const goal = goals.find((g) => g.id === row.id);
    // 5000 + 7000 - 1234 + 2345 + 10050 = 23161 exact cents.
    expect(goal).toMatchObject({ netCents: 23_161, contributionCount: 5 });
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
