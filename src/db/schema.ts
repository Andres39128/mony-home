import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres bytea — receipt image bytes (drivers map Buffer both ways). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Database schema for mony-home — single source of truth.
 *
 * Conventions:
 * - All primary keys are `uuid().defaultRandom()`.
 * - All tables carry `created_at timestamptz default now()`.
 * - Column names are explicit snake_case; TS keys stay camelCase.
 * - Money is ALWAYS integer cents (never floats, never numeric columns),
 *   stored as bigint: int4 caps at ~$21M ARS in cents, which real
 *   household savings targets already exceed.
 * - "común" scope is stored as 'common'.
 */

export const roleEnum = pgEnum("role", ["admin", "member"]);
export const categoryKindEnum = pgEnum("category_kind", ["income", "expense"]);
export const transactionTypeEnum = pgEnum("transaction_type", ["income", "expense"]);
export const scopeKindEnum = pgEnum("scope_kind", ["individual", "common"]);
export const groupStatusEnum = pgEnum("group_status", ["active", "closed"]);
export const savingsKindEnum = pgEnum("savings_kind", ["savings", "investment"]);
export const contributionKindEnum = pgEnum("contribution_kind", ["deposit", "withdrawal", "interest"]);
export const accrualModeEnum = pgEnum("accrual_mode", ["simple", "compound"]);
export const loanKindEnum = pgEnum("loan_kind", ["credit_card", "investment_line", "mortgage", "other"]);
export const loanPaymentKindEnum = pgEnum("loan_payment_kind", ["payment", "interest"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull().default("member"),
  isActive: boolean("is_active").notNull().default(true),
  /** Failed login attempts since last success; reset on success or after a lockout window expires. */
  failedAttempts: integer("failed_attempts").notNull().default(0),
  /** When set and in the future, login is rejected before credential verification. */
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the session token; the raw token lives only in the user's cookie. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  kind: categoryKindEnum("kind").notNull(),
  color: text("color").notNull().default("#64748b"),
  icon: text("icon"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const expenseGroups = pgTable("expense_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: groupStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    date: date("date", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    type: transactionTypeEnum("type").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").references(() => expenseGroups.id, { onDelete: "set null" }),
    /** Set on mirror rows: the savings contribution that generated this movement. */
    savingsContributionId: uuid("savings_contribution_id").references(() => savingsContributions.id, {
      onDelete: "cascade",
    }),
    /** Set on mirror rows: the loan payment that generated this movement. */
    loanPaymentId: uuid("loan_payment_id").references(() => loanPayments.id, {
      onDelete: "cascade",
    }),
    scope: scopeKindEnum("scope").notNull().default("common"),
    note: text("note"),
    /** Quick-capture placeholder ("momento de afán"): details pending. */
    needsDetails: boolean("needs_details").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Completed movements must be positive and categorized; pending
    // quick-capture rows are exempt (they start at 0 with no category).
    check(
      "transactions_completed_amount_positive",
      sql`${table.needsDetails} OR ${table.amountCents} > 0`,
    ),
    check(
      "transactions_completed_category_present",
      sql`${table.needsDetails} OR ${table.categoryId} IS NOT NULL`,
    ),
    index("transactions_date_idx").on(table.date),
    index("transactions_category_id_idx").on(table.categoryId),
    index("transactions_member_id_idx").on(table.memberId),
    index("transactions_group_id_idx").on(table.groupId),
    index("transactions_savings_contribution_id_idx").on(table.savingsContributionId),
    index("transactions_loan_payment_id_idx").on(table.loanPaymentId),
  ],
);

/**
 * Receipt images attached to movements (max one per movement, enforced by the
 * service: attaching on edit deletes the previous row first). Bytes live in
 * Postgres — the app runs on serverless with no writable disk. Deletion of
 * the movement cascades to its receipt.
 */
export const movementReceipts = pgTable("movement_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  bytes: bytea("bytes").notNull(),
  /** Sniffed/allow-listed image type: image/jpeg | image/png | image/webp. */
  mimeType: text("mime_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assistantUsage = pgTable(
  "assistant_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Calendar day ('YYYY-MM-DD'); the daily quota resets by this key. */
    day: date("day", { mode: "string" }).notNull(),
    /** Requests served that day; incremented atomically on success. */
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("assistant_usage_user_id_day_unique").on(table.userId, table.day),
    check("assistant_usage_count_non_negative", sql`${table.count} >= 0`),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** First day of the month, e.g. '2026-09-01'. */
    month: date("month", { mode: "string" }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("budgets_month_category_id_unique").on(table.month, table.categoryId),
    check("budgets_amount_non_negative", sql`${table.amountCents} >= 0`),
    index("budgets_month_idx").on(table.month),
  ],
);

/**
 * Savings goals and investments. A savings goal ('savings') is a cumulative
 * pool with optional target/deadline; an investment ('investment') tracks a
 * manually updated current value. Contributions live in the SEPARATE
 * savings_contributions ledger; deposit/withdrawal mirror into `transactions`
 * (income/expense) so household stats reflect the real money flow.
 */
export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    kind: savingsKindEnum("kind").notNull().default("savings"),
    scope: scopeKindEnum("scope").notNull().default("common"),
    /** null = common goal; required when scope is 'individual'. */
    memberId: uuid("member_id").references(() => users.id),
    /** Cumulative target; null = open pool (no progress bar). */
    targetCents: bigint("target_cents", { mode: "number" }),
    deadline: date("deadline", { mode: "string" }),
    /** Investments only: last manually-set valuation; null = never updated. */
    currentValueCents: bigint("current_value_cents", { mode: "number" }),
    valueUpdatedAt: timestamp("value_updated_at", { withTimezone: true }),
    /** Where the money is held (banco, billetera, fondo…); free text, optional. */
    institution: text("institution"),
    /** Annual rate in basis points; null = no yield. 0..100000 = 0..1000%. */
    annualRateBp: integer("annual_rate_bp"),
    /**
     * Daily accrual mode (savings goals with a rate only):
     * 'simple' treats the rate as NOMINAL annual (TNA) earned on the
     * principal only; 'compound' treats it as EFFECTIVE annual (TEA) earned
     * on the running balance. Null when there is no rate (or for
     * investments, which accrue nothing — manual valuation only).
     */
    accrualMode: accrualModeEnum("accrual_mode"),
    /** 'YYYY-MM-01' — month the rate was last reviewed; drives the review banner. */
    rateReviewedMonth: date("rate_reviewed_month", { mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "savings_goals_individual_requires_member",
      sql`${table.scope} <> 'individual' OR ${table.memberId} IS NOT NULL`,
    ),
    check(
      "savings_goals_target_non_negative",
      sql`${table.targetCents} IS NULL OR ${table.targetCents} >= 0`,
    ),
    check(
      "savings_goals_current_value_non_negative",
      sql`${table.currentValueCents} IS NULL OR ${table.currentValueCents} >= 0`,
    ),
    check(
      "savings_goals_annual_rate_bp_bounds",
      sql`${table.annualRateBp} IS NULL OR (${table.annualRateBp} >= 0 AND ${table.annualRateBp} <= 100000)`,
    ),
  ],
);

/**
 * Contributions ledger: deposits add to a goal's net accumulation,
 * withdrawals subtract (emergency funds get used), 'interest' rows are the
 * visible monthly yield entries written by the accrual engine (member-less).
 * Not a `transactions` row by itself — deposit/withdrawal get a MIRROR row
 * in `transactions` so income/expense stats reflect real money flow.
 */
export const savingsContributions = pgTable(
  "savings_contributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => savingsGoals.id, { onDelete: "restrict" }),
    /** null exactly for 'interest' rows — yield belongs to the pool, not a member. */
    memberId: uuid("member_id").references(() => users.id, { onDelete: "restrict" }),
    kind: contributionKindEnum("kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    date: date("date", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Deposits/withdrawals are positive; interest is signed (a valuation
    // true-up that LOSES value records a negative interest entry).
    check(
      "savings_contributions_amount_positive",
      sql`(${table.kind} = 'interest' AND ${table.amountCents} <> 0) OR ${table.amountCents} > 0`,
    ),
    // 'interest' ⇔ member IS NULL: deposits/withdrawals always name a member.
    check(
      "savings_contributions_interest_member_exclusive",
      sql`(${table.kind} = 'interest') = (${table.memberId} IS NULL)`,
    ),
    // One interest entry per goal/month/cause — makes lazy concurrent
    // catch-ups idempotent even when two requests race on the same view.
    uniqueIndex("savings_contributions_interest_unique")
      .on(table.goalId, table.date, table.note)
      .where(sql`${table.kind} = 'interest'`),
    index("savings_contributions_goal_date_idx").on(table.goalId, table.date),
  ],
);

/**
 * Household debts (credit cards, investment lines, mortgages). The
 * OUTSTANDING balance is never stored: outstanding = principal + interest −
 * payments, computed from the loan_payments ledger. Loan proceeds create NO
 * transaction — borrowed money is not income; payments mirror an expense.
 */
export const loans = pgTable(
  "loans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    kind: loanKindEnum("kind").notNull(),
    /** Lending entity ("Visa Banco Nación", "Banco Hipotecario"…); required. */
    entity: text("entity").notNull(),
    scope: scopeKindEnum("scope").notNull().default("common"),
    /** null = common loan; required when scope is 'individual'. */
    memberId: uuid("member_id").references(() => users.id),
    /** Original borrowed amount; always positive. */
    principalCents: bigint("principal_cents", { mode: "number" }).notNull(),
    /** Annual nominal rate (TNA) in basis points; null = no interest. 0..100000 = 0..1000%. */
    annualRateBp: integer("annual_rate_bp"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "loans_individual_requires_member",
      sql`${table.scope} <> 'individual' OR ${table.memberId} IS NOT NULL`,
    ),
    check("loans_principal_positive", sql`${table.principalCents} > 0`),
    check(
      "loans_annual_rate_bp_bounds",
      sql`${table.annualRateBp} IS NULL OR (${table.annualRateBp} >= 0 AND ${table.annualRateBp} <= 100000)`,
    ),
  ],
);

/**
 * Loan payments ledger: 'payment' rows reduce the debt and MIRROR an expense
 * in `transactions` (paying a loan is real money leaving the household);
 * 'interest' rows are written by the lazy monthly accrual (or by admin
 * balance true-ups) and never mirror. Member-less exactly for 'interest'.
 */
export const loanPayments = pgTable(
  "loan_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "restrict" }),
    /** null exactly for 'interest' rows — a charge belongs to the loan, not a member. */
    memberId: uuid("member_id").references(() => users.id, { onDelete: "restrict" }),
    kind: loanPaymentKindEnum("kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    date: date("date", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Payments are positive; interest is signed (a balance true-up that
    // REDUCES the debt records a negative interest entry).
    check(
      "loan_payments_amount_positive",
      sql`(${table.kind} = 'interest' AND ${table.amountCents} <> 0) OR ${table.amountCents} > 0`,
    ),
    // 'interest' ⇔ member IS NULL: payments always name a member.
    check(
      "loan_payments_interest_member_exclusive",
      sql`(${table.kind} = 'interest') = (${table.memberId} IS NULL)`,
    ),
    // One interest entry per loan/month/cause — makes lazy concurrent
    // catch-ups idempotent even when two requests race on the same view.
    uniqueIndex("loan_payments_interest_unique")
      .on(table.loanId, table.date, table.note)
      .where(sql`${table.kind} = 'interest'`),
    index("loan_payments_loan_date_idx").on(table.loanId, table.date),
  ],
);
