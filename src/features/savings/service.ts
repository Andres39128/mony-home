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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, savingsContributions, savingsGoals, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import { parseAmountToCents } from "@/lib/money";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/features/transactions/service";
import { catchUpAllInterest } from "./accrual";
// Pure math lives in a client-safe module; re-exported here so the service
// stays the single import surface for server-side callers and tests.
export {
  computeNetCents,
  computeGoalProgress,
  computeInvestmentReturn,
  investmentValueCents,
  monthsUntilDeadline,
} from "./math";
import { investmentValueCents } from "./math";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    /** Where the money is held ("banco", "billetera"…); empty string = unset. */
    institution: z.union([z.string().trim().max(64, "Máximo 64 caracteres"), z.literal("")]),
    /** AR-tolerant annual percent ("35,5" = 35,5% TNA); empty string = no yield. */
    annualRate: optionalAmount,
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
  /** Where the money is held; null = unset. */
  institution: string | null;
  /** Annual nominal rate in bp; null = no yield. */
  annualRateBp: number | null;
  /** Sum of interest entries — what the goal has generated so far. */
  interestTotalCents: number;
  isActive: boolean;
  /** deposits − withdrawals + interest across all months (exact cents). */
  netCents: number;
  contributionCount: number;
}

export interface ContributionView {
  id: string;
  /** Owning goal — lets one query feed every card's collapsible history. */
  goalId: string;
  kind: "deposit" | "withdrawal" | "interest";
  amountCents: number;
  date: string;
  note: string | null;
  /** null on interest rows (yield belongs to the pool, not a member). */
  memberId: string | null;
  memberName: string | null;
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
  // Lazy catch-up first so every read path (list, patrimony, detail) shows
  // interest that has accrued up to now. No-op without rate-bearing goals.
  await catchUpAllInterest(db);

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
      institution: savingsGoals.institution,
      annualRateBp: savingsGoals.annualRateBp,
      isActive: savingsGoals.isActive,
      net: sql<string | null>`coalesce(sum(case ${savingsContributions.kind} when 'deposit' then ${savingsContributions.amountCents} when 'withdrawal' then -${savingsContributions.amountCents} else ${savingsContributions.amountCents} end), 0)`,
      interestTotal: sql<string | null>`coalesce(sum(case when ${savingsContributions.kind} = 'interest' then ${savingsContributions.amountCents} else 0 end), 0)`,
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
    interestTotalCents: Number(row.interestTotal ?? 0),
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

/**
 * AR-tolerant annual percent → basis points. Reuses the sanctioned money
 * parser: percent cents ARE basis points ("35,5" → 3550 bp, "70" → 7000).
 * Empty = null = no yield; caps at 1000% TNA (100000 bp).
 */
function parseOptionalRate(rate: string): { bp: number | null } | { error: "invalid_rate" } {
  if (rate === "") return { bp: null };
  let bp: number;
  try {
    bp = parseAmountToCents(rate);
  } catch {
    return { error: "invalid_rate" };
  }
  if (bp < 0 || bp > 100000) return { error: "invalid_rate" };
  return { bp };
}

function goalValues(input: GoalInput, targetCents: number | null, rateBp: number | null) {
  return {
    name: input.name,
    kind: input.kind,
    scope: input.scope,
    memberId: input.scope === "individual" ? input.memberId : null,
    targetCents: input.kind === "savings" ? targetCents : null,
    deadline: input.kind === "savings" && input.deadline !== "" ? input.deadline : null,
    institution: input.institution !== "" ? input.institution : null,
    annualRateBp: rateBp,
  };
}

export type GoalResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_target"
        | "invalid_current_value"
        | "invalid_rate"
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
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: rate.error };

  try {
    await db.insert(savingsGoals).values({
      ...goalValues(input, target.cents, rate.bp),
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
  const rate = parseOptionalRate(input.annualRate);
  if ("error" in rate) return { ok: false, error: rate.error };

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
        ...goalValues(input, target.cents, rate.bp),
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
        | "system_category_missing"
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

/**
 * Mirror categories (system-seeded): a savings DEPOSIT is money that LEFT
 * the household's income/expense flow — an expense; a WITHDRAWAL returns it
 * — income. Same member, date, scope and amount as the contribution, linked
 * via transactions.savings_contribution_id (CASCADE delete).
 */
const MIRROR_DEPOSIT_CATEGORY = "Ahorro e inversión";
const MIRROR_WITHDRAWAL_CATEGORY = "Recupero de ahorro";

export async function addContribution(
  db: Database,
  user: SessionUser,
  goalId: string,
  input: ContributionInput,
): Promise<ContributionResult> {
  const cents = parseAmountCents(input.amount);
  if (cents === null || cents <= 0) return { ok: false, error: "invalid_amount" };

  // Contribution + mirror commit together (R1): stats never diverge from
  // the savings ledger. Interest rows never pass through here.
  return db.transaction(async (tx) => {
    const [goal] = await tx
      .select({ name: savingsGoals.name, scope: savingsGoals.scope, isActive: savingsGoals.isActive })
      .from(savingsGoals)
      .where(eq(savingsGoals.id, goalId))
      .limit(1);
    if (!goal) return { ok: false, error: "goal_not_found" };
    if (!goal.isActive) return { ok: false, error: "goal_inactive" };

    const member = resolveMemberId(user, input.memberId);
    if (!member.ok) return member;

    const mirror =
      input.kind === "deposit"
        ? { type: "expense" as const, categoryName: MIRROR_DEPOSIT_CATEGORY, note: `Aporte a ${goal.name}` }
        : { type: "income" as const, categoryName: MIRROR_WITHDRAWAL_CATEGORY, note: `Retiro de ${goal.name}` };

    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, mirror.categoryName))
      .limit(1);
    // Run `npm run db:seed` after deploying: both modes create these.
    if (!category) return { ok: false, error: "system_category_missing" };

    try {
      const [contribution] = await tx
        .insert(savingsContributions)
        .values({
          goalId,
          memberId: member.memberId,
          kind: input.kind,
          amountCents: cents,
          date: input.date,
          note: input.note ? input.note : null,
        })
        .returning({ id: savingsContributions.id });

      await tx.insert(transactions).values({
        date: input.date,
        amountCents: cents,
        type: mirror.type,
        categoryId: category.id,
        memberId: member.memberId,
        scope: goal.scope,
        note: mirror.note,
        savingsContributionId: contribution.id,
      });
      return { ok: true };
    } catch (error) {
      if (hasPgError(error, "23503")) return { ok: false, error: "member_not_found" };
      throw error;
    }
  });
}

/** Full history (optionally one goal's), newest first. Feeds the /ahorro cards. */
export async function listContributions(
  db: Database,
  goalId?: string,
): Promise<ContributionView[]> {
  return db
    .select({
      id: savingsContributions.id,
      goalId: savingsContributions.goalId,
      kind: savingsContributions.kind,
      amountCents: savingsContributions.amountCents,
      date: savingsContributions.date,
      note: savingsContributions.note,
      memberId: savingsContributions.memberId,
      memberName: users.name,
    })
    .from(savingsContributions)
    .leftJoin(users, eq(savingsContributions.memberId, users.id))
    .where(goalId ? eq(savingsContributions.goalId, goalId) : undefined)
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

/** Admin-only manual valuation. Rate-bearing goals get a true-up: the delta
 * against the real balance materializes as ONE visible 'interest' row
 * ("Ajuste de valoración") and value_updated_at becomes the new accrual
 * base. Re-valuating the same day replaces that day's adjustment (the
 * ledger keeps ONE net adjustment converging to the latest stated value).
 * Non-rate investments keep the plain valuation behavior. */
export async function updateGoalValue(
  db: Database,
  user: SessionUser,
  goalId: string,
  currentValue: string,
): Promise<ValueResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  // Pre-check for typed errors; the mutations below re-check via the tx
  // (a goal deleted mid-flight simply updates zero rows).
  const [existing] = await db
    .select({ kind: savingsGoals.kind, annualRateBp: savingsGoals.annualRateBp })
    .from(savingsGoals)
    .where(eq(savingsGoals.id, goalId))
    .limit(1);
  if (!existing) return { ok: false, error: "goal_not_found" };
  if (existing.kind !== "investment" && existing.annualRateBp === null) {
    return { ok: false, error: "not_investment" };
  }

  const cents = parseAmountCents(currentValue);
  if (cents === null || cents < 0) return { ok: false, error: "invalid_current_value" };

  await db.transaction(async (tx) => {
    const [goal] = await tx
      .select({
        kind: savingsGoals.kind,
        annualRateBp: savingsGoals.annualRateBp,
        currentValueCents: savingsGoals.currentValueCents,
      })
      .from(savingsGoals)
      .where(eq(savingsGoals.id, goalId))
      .limit(1)
      .for("update");
    if (!goal) return;
    if (goal.kind !== "investment" && goal.annualRateBp === null) return;

    if (goal.annualRateBp === null) {
      await tx
        .update(savingsGoals)
        .set({ currentValueCents: cents, valueUpdatedAt: new Date() })
        .where(eq(savingsGoals.id, goalId));
      return;
    }

    // True-up: absorb (stated value − current balance) into the ledger so
    // the visible net matches what the goal is really worth, then rebase.
    // A same-day adjustment is replaced so repeated valuations converge.
    const today = todayIso();
    await tx
      .delete(savingsContributions)
      .where(
        and(
          eq(savingsContributions.goalId, goalId),
          eq(savingsContributions.kind, "interest"),
          eq(savingsContributions.date, today),
          eq(savingsContributions.note, "Ajuste de valoración"),
        ),
      );
    const [balance] = await tx
      .select({
        balance: sql<number>`coalesce(sum(case ${savingsContributions.kind} when 'deposit' then ${savingsContributions.amountCents} when 'withdrawal' then -${savingsContributions.amountCents} else ${savingsContributions.amountCents} end), 0)`,
      })
      .from(savingsContributions)
      .where(eq(savingsContributions.goalId, goalId));
    const delta = cents - Number(balance?.balance ?? 0);

    if (delta !== 0) {
      await tx.insert(savingsContributions).values({
        goalId,
        memberId: null,
        kind: "interest",
        amountCents: delta,
        date: today,
        note: "Ajuste de valoración",
      });
    }
    await tx
      .update(savingsGoals)
      .set({
        currentValueCents: goal.kind === "investment" ? cents : null,
        valueUpdatedAt: new Date(),
      })
      .where(eq(savingsGoals.id, goalId));
  });
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
