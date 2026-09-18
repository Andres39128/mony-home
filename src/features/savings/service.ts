/**
 * Savings & investments service — goals, contributions and patrimony.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Goal CRUD and value updates are admin-only and take the
 * calling SessionUser to enforce the role at service level. Contributions
 * are open to any authenticated member, always attributed to themselves
 * unless an admin says otherwise (movements rule 6). Amounts arrive as free
 * text and ALWAYS go through money.parseAmountToCents (R2).
 *
 * Contributions are a ledger SEPARATE from transactions: saving is neither
 * income nor expense and must never pollute those stats.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { savingsContributions, savingsGoals, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import { parseAmountToCents, percentage } from "@/lib/money";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/features/transactions/service";
import { computeProgress, type Progress } from "@/features/budgets/progress";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Net accumulation of a goal: deposits minus withdrawals, across ALL months
 * (unlike bolsas monthly progress — a savings pool accumulates over time).
 */
export function computeNetCents(
  depositsCents: number,
  withdrawalsCents: number,
): number {
  return depositsCents - withdrawalsCents;
}

/**
 * Progress toward the target using the SHARED budgets math (one source of
 * truth for thresholds and divide-by-zero). No target → no bar (null).
 */
export function computeGoalProgress(
  netCents: number,
  targetCents: number | null,
): Progress | null {
  if (targetCents === null) return null;
  return computeProgress(targetCents, netCents);
}

/**
 * Investment return: (current − net invested) / net invested, as a
 * 2-decimal percentage. Never-updated value falls back to net invested
 * (→ 0%) and a zero net invested avoids division by zero (→ 0%).
 */
export function computeInvestmentReturn(
  netInvestedCents: number,
  currentValueCents: number | null,
): number {
  if (netInvestedCents <= 0) return 0;
  const value = currentValueCents ?? netInvestedCents;
  return percentage(value - netInvestedCents, netInvestedCents);
}

/**
 * Whole months from today until the deadline month; negative when overdue,
 * null when there is no deadline. Month granularity on purpose ("vence en
 * N meses" — day precision would make the copy jitter daily).
 */
export function monthsUntilDeadline(
  deadline: string | null,
  today: string = todayIso(),
): number | null {
  if (!deadline) return null;
  const [todayYear, todayMonth] = today.split("-").map(Number);
  const [goalYear, goalMonth] = deadline.split("-").map(Number);
  return (goalYear - todayYear) * 12 + (goalMonth - todayMonth);
}

/** Effective patrimony value: the current valuation, else net invested. */
export function investmentValueCents(
  netCents: number,
  currentValueCents: number | null,
): number {
  return currentValueCents ?? netCents;
}

// ---------------------------------------------------------------------------
// Validation (trust boundary)
// ---------------------------------------------------------------------------

/** Empty string = no amount (open pool / no deadline / value not set yet). */
const optionalAmount = z.union([z.string().trim(), z.literal("")]);

export const goalSchema = z
  .object({
    name: z.string().trim().min(1, "El nombre es obligatorio").max(64, "Máximo 64 caracteres"),
    kind: z.enum(["savings", "investment"]),
    scope: z.enum(["individual", "common"]),
    /** Empty string = common goal without owner. */
    memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
    target: optionalAmount,
    deadline: z.union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")]),
    currentValue: optionalAmount,
  })
  .refine((v) => v.scope !== "individual" || v.memberId !== "", {
    message: "Las metas individuales requieren un integrante.",
    path: ["memberId"],
  })
  .refine((v) => v.scope !== "common" || v.memberId === "", {
    message: "Las metas comunes no llevan integrante.",
    path: ["memberId"],
  })
  .refine((v) => v.kind !== "savings" || v.currentValue === "", {
    message: "Las metas de ahorro no llevan valor actual.",
    path: ["currentValue"],
  })
  .refine((v) => v.kind !== "investment" || (v.target === "" && v.deadline === ""), {
    message: "Las inversiones no llevan objetivo ni plazo.",
    path: ["target"],
  });

export type GoalInput = z.output<typeof goalSchema>;

export const contributionSchema = z.object({
  /** Free-text AR-formatted amount ("1.234,56"); parsed to cents by the service. */
  amount: z.string().trim().min(1, "El monto es obligatorio"),
  kind: z.enum(["deposit", "withdrawal"]),
  /** Empty string = today (quick-entry forms may omit the date). */
  date: z
    .union([z.iso.date({ message: "La fecha no es válida" }), z.literal("")])
    .transform((v) => (v === "" ? todayIso() : v)),
  note: z.union([z.string().trim().max(200, "Máximo 200 caracteres"), z.literal("")]),
  /** Empty string = the acting user; admins may attribute to any member. */
  memberId: z.union([z.string().regex(UUID_RE, "Integrante inválido"), z.literal("")]),
});

export type ContributionInput = z.output<typeof contributionSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface GoalView {
  id: string;
  name: string;
  kind: "savings" | "investment";
  scope: "individual" | "common";
  memberId: string | null;
  memberName: string | null;
  targetCents: number | null;
  deadline: string | null;
  currentValueCents: number | null;
  valueUpdatedAt: Date | null;
  isActive: boolean;
  /** deposits − withdrawals across all months (exact cents). */
  netCents: number;
  contributionCount: number;
}

export interface ContributionView {
  id: string;
  kind: "deposit" | "withdrawal";
  amountCents: number;
  date: string;
  note: string | null;
  memberId: string;
  memberName: string;
}

export interface PatrimonyBreakdown {
  id: string;
  name: string;
  kind: "savings" | "investment";
  /** Savings: net accumulated; investments: current value (net fallback). */
  valueCents: number;
}

export interface Patrimony {
  savingsCents: number;
  investmentsCents: number;
  totalCents: number;
  goals: PatrimonyBreakdown[];
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export async function listGoals(db: Database): Promise<GoalView[]> {
  const rows = await db
    .select({
      id: savingsGoals.id,
      name: savingsGoals.name,
      kind: savingsGoals.kind,
      scope: savingsGoals.scope,
      memberId: savingsGoals.memberId,
      memberName: users.name,
      targetCents: savingsGoals.targetCents,
      deadline: savingsGoals.deadline,
      currentValueCents: savingsGoals.currentValueCents,
      valueUpdatedAt: savingsGoals.valueUpdatedAt,
      isActive: savingsGoals.isActive,
      net: sql<string | null>`coalesce(sum(case when ${savingsContributions.kind} = 'deposit' then ${savingsContributions.amountCents} else -${savingsContributions.amountCents} end), 0)`,
      contributionCount: sql<string | null>`count(${savingsContributions.id})`,
    })
    .from(savingsGoals)
    .leftJoin(users, eq(savingsGoals.memberId, users.id))
    .leftJoin(savingsContributions, eq(savingsContributions.goalId, savingsGoals.id))
    .groupBy(savingsGoals.id, users.name)
    .orderBy(
      // Active first, savings before investments, then by name.
      sql`case when ${savingsGoals.isActive} then 0 else 1 end`,
      sql`case when ${savingsGoals.kind} = 'savings' then 0 else 1 end`,
      asc(savingsGoals.name),
    );

  return rows.map((row) => ({
    ...row,
    memberName: row.memberName ?? null,
    netCents: Number(row.net ?? 0),
    contributionCount: Number(row.contributionCount ?? 0),
  }));
}

/** Returns null when the free-text amount cannot be parsed. */
function parseAmountCents(amount: string): number | null {
  try {
    return parseAmountToCents(amount);
  } catch {
    return null;
  }
}

/** Optional free-text amount → cents, or a typed error code. */
function parseOptionalCents(
  amount: string,
  errorKey: "invalid_target" | "invalid_current_value",
): { cents: number | null } | { error: "invalid_target" | "invalid_current_value" } {
  if (amount === "") return { cents: null };
  const cents = parseAmountCents(amount);
  if (cents === null || cents < 0) return { error: errorKey };
  return { cents };
}

function goalValues(input: GoalInput, targetCents: number | null) {
  return {
    name: input.name,
    kind: input.kind,
    scope: input.scope,
    memberId: input.scope === "individual" ? input.memberId : null,
    targetCents: input.kind === "savings" ? targetCents : null,
    deadline: input.kind === "savings" && input.deadline !== "" ? input.deadline : null,
  };
}

export type GoalResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_target"
        | "invalid_current_value"
        | "member_not_found"
        | "goal_not_found"
        | "has_contributions"
        | "forbidden";
    };

/**
 * Kind-specific field invariants. The zod schema mirrors them for friendly
 * field errors; the service enforces them because no DB CHECK backs them up.
 */
function checkKindFields(input: GoalInput): GoalResult | null {
  if (input.kind === "savings" && input.currentValue !== "") {
    return { ok: false, error: "invalid_current_value" };
  }
  if (input.kind === "investment" && (input.target !== "" || input.deadline !== "")) {
    return { ok: false, error: "invalid_target" };
  }
  return null;
}

export async function createGoal(
  db: Database,
  user: SessionUser,
  input: GoalInput,
): Promise<GoalResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const kindError = checkKindFields(input);
  if (kindError) return kindError;
  const target = parseOptionalCents(input.target, "invalid_target");
  if ("error" in target) return { ok: false, error: target.error };
  const value = parseOptionalCents(input.currentValue, "invalid_current_value");
  if ("error" in value) return { ok: false, error: value.error };

  try {
    await db.insert(savingsGoals).values({
      ...goalValues(input, target.cents),
      currentValueCents: input.kind === "investment" ? value.cents : null,
      valueUpdatedAt: input.kind === "investment" && value.cents !== null ? new Date() : null,
    });
    return { ok: true };
  } catch (error) {
    // Stale member option (deleted between render and submit).
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function updateGoal(
  db: Database,
  user: SessionUser,
  id: string,
  input: GoalInput,
): Promise<GoalResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const kindError = checkKindFields(input);
  if (kindError) return kindError;
  const target = parseOptionalCents(input.target, "invalid_target");
  if ("error" in target) return { ok: false, error: target.error };
  const value = parseOptionalCents(input.currentValue, "invalid_current_value");
  if ("error" in value) return { ok: false, error: value.error };

  const [existing] = await db
    .select({ currentValueCents: savingsGoals.currentValueCents })
    .from(savingsGoals)
    .where(eq(savingsGoals.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "goal_not_found" };

  // Value edits through the goal form only bump the valuation timestamp when
  // the amount actually changed; empty input keeps the investment's value.
  let currentValueCents = existing.currentValueCents;
  let valueUpdatedAt: Date | null | undefined = undefined;
  if (input.kind === "savings") {
    currentValueCents = null;
    valueUpdatedAt = null;
  } else if (value.cents !== null) {
    currentValueCents = value.cents;
    valueUpdatedAt = value.cents === existing.currentValueCents ? undefined : new Date();
  }

  try {
    const updated = await db
      .update(savingsGoals)
      .set({
        ...goalValues(input, target.cents),
        currentValueCents,
        ...(valueUpdatedAt === undefined ? {} : { valueUpdatedAt }),
      })
      .where(eq(savingsGoals.id, id))
      .returning({ id: savingsGoals.id });
    if (updated.length === 0) return { ok: false, error: "goal_not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function toggleGoalActive(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<GoalResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(savingsGoals)
    .set({ isActive: sql`not ${savingsGoals.isActive}` })
    .where(eq(savingsGoals.id, id))
    .returning({ id: savingsGoals.id });
  if (updated.length === 0) return { ok: false, error: "goal_not_found" };
  return { ok: true };
}

export async function removeGoal(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<GoalResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    const deleted = await db
      .delete(savingsGoals)
      .where(eq(savingsGoals.id, id))
      .returning({ id: savingsGoals.id });
    if (deleted.length === 0) return { ok: false, error: "goal_not_found" };
    return { ok: true };
  } catch (error) {
    // RESTRICT FK: savings_contributions.goal_id (23001 on PGlite, 23503 on PG 17).
    if (hasPgFkError(error)) return { ok: false, error: "has_contributions" };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export type ContributionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_amount"
        | "goal_not_found"
        | "goal_inactive"
        | "member_not_found"
        | "forbidden";
    };

/** Member attribution: empty = the acting user; non-admins cannot target others. */
function resolveMemberId(
  user: SessionUser,
  memberId: string,
): { ok: true; memberId: string } | { ok: false; error: "forbidden" } {
  const resolved = memberId === "" ? user.id : memberId;
  if (user.role !== "admin" && resolved !== user.id) return { ok: false, error: "forbidden" };
  return { ok: true, memberId: resolved };
}

export async function addContribution(
  db: Database,
  user: SessionUser,
  goalId: string,
  input: ContributionInput,
): Promise<ContributionResult> {
  const cents = parseAmountCents(input.amount);
  if (cents === null || cents <= 0) return { ok: false, error: "invalid_amount" };

  const [goal] = await db
    .select({ isActive: savingsGoals.isActive })
    .from(savingsGoals)
    .where(eq(savingsGoals.id, goalId))
    .limit(1);
  if (!goal) return { ok: false, error: "goal_not_found" };
  if (!goal.isActive) return { ok: false, error: "goal_inactive" };

  const member = resolveMemberId(user, input.memberId);
  if (!member.ok) return member;

  try {
    await db.insert(savingsContributions).values({
      goalId,
      memberId: member.memberId,
      kind: input.kind,
      amountCents: cents,
      date: input.date,
      note: input.note ? input.note : null,
    });
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
    throw error;
  }
}

export async function listContributionsByGoal(
  db: Database,
  goalId: string,
): Promise<ContributionView[]> {
  return db
    .select({
      id: savingsContributions.id,
      kind: savingsContributions.kind,
      amountCents: savingsContributions.amountCents,
      date: savingsContributions.date,
      note: savingsContributions.note,
      memberId: savingsContributions.memberId,
      memberName: users.name,
    })
    .from(savingsContributions)
    .innerJoin(users, eq(savingsContributions.memberId, users.id))
    .where(eq(savingsContributions.goalId, goalId))
    .orderBy(desc(savingsContributions.date), desc(savingsContributions.createdAt));
}

// ---------------------------------------------------------------------------
// Investment valuation
// ---------------------------------------------------------------------------

export type ValueResult =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_current_value" | "goal_not_found" | "not_investment" | "forbidden";
    };

/** Admin-only manual valuation of an investment. */
export async function updateGoalValue(
  db: Database,
  user: SessionUser,
  goalId: string,
  currentValue: string,
): Promise<ValueResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const [goal] = await db
    .select({ kind: savingsGoals.kind })
    .from(savingsGoals)
    .where(eq(savingsGoals.id, goalId))
    .limit(1);
  if (!goal) return { ok: false, error: "goal_not_found" };
  if (goal.kind !== "investment") return { ok: false, error: "not_investment" };

  const cents = parseAmountCents(currentValue);
  if (cents === null || cents < 0) return { ok: false, error: "invalid_current_value" };

  const updated = await db
    .update(savingsGoals)
    .set({ currentValueCents: cents, valueUpdatedAt: new Date() })
    .where(eq(savingsGoals.id, goalId))
    .returning({ id: savingsGoals.id });
  if (updated.length === 0) return { ok: false, error: "goal_not_found" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Patrimony
// ---------------------------------------------------------------------------

/**
 * Household net worth: net accumulated of savings goals plus the current
 * value of investments (net invested when never valued). Includes inactive
 * goals — deactivating a tracker does not withdraw the money.
 */
export async function getPatrimony(db: Database): Promise<Patrimony> {
  const goals = await listGoals(db);
  const breakdown: PatrimonyBreakdown[] = goals.map((goal) => ({
    id: goal.id,
    name: goal.name,
    kind: goal.kind,
    valueCents:
      goal.kind === "investment"
        ? investmentValueCents(goal.netCents, goal.currentValueCents)
        : goal.netCents,
  }));
  const savingsCents = breakdown
    .filter((goal) => goal.kind === "savings")
    .reduce((total, goal) => total + goal.valueCents, 0);
  const investmentsCents = breakdown
    .filter((goal) => goal.kind === "investment")
    .reduce((total, goal) => total + goal.valueCents, 0);
  return { savingsCents, investmentsCents, totalCents: savingsCents + investmentsCents, goals: breakdown };
}
