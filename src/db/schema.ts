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
 *   Runtime contract: `bigint({ mode: "number" })` is safe — 2^53 cents
 *   ceiling, guarded per-value by `Number.isSafeInteger` in `src/lib/money.ts`;
 *   SQL SUM aggregates are assumed below that ceiling (they de-stringify via
 *   `Number(...)`).
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
export const loanPaymentKindEnum = pgEnum("loan_payment_kind", ["payment", "interest", "charge"]);
export const loanAmortizationModeEnum = pgEnum("loan_amortization_mode", ["bank"]);

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
    /** Set on auto-generated rows: the recurring movement that created this one. */
    recurringId: uuid("recurring_id").references(() => recurringMovements.id, {
      onDelete: "set null",
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
    index("transactions_recurring_id_idx").on(table.recurringId),
    // Idempotent materialization: at most ONE auto-generated transaction per
    // recurring per day — a racing lazy catch-up inserts nothing extra.
    uniqueIndex("transactions_recurring_id_date_unique")
      .on(table.recurringId, table.date)
      .where(sql`${table.recurringId} IS NOT NULL`),
  ],
);

/**
 * Receipt images attached to movements (max one per movement, enforced by
 * the DB UNIQUE below AND by the service: attaching on edit deletes the
 * previous row first). Bytes live in Postgres — the app runs on serverless
 * with no writable disk. Deletion of the movement cascades to its receipt.
 */
export const movementReceipts = pgTable("movement_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id")
    .notNull()
    .unique()
    .references(() => transactions.id, { onDelete: "cascade" }),
  bytes: bytea("bytes").notNull(),
  /** Sniffed/allow-listed image type: image/jpeg | image/png | image/webp. */
  mimeType: text("mime_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-IP failed-login ledger backing the login rate limit (migration 0009).
 * Append-only log: no primary key because rows are never addressed — every
 * query filters by (ip, attempted_at), which the index covers. Pruned
 * opportunistically after each failed attempt (see src/lib/auth.ts).
 */
export const loginIpAttempts = pgTable(
  "login_ip_attempts",
  {
    ip: text("ip").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("login_ip_attempts_ip_attempted_at_idx").on(table.ip, table.attemptedAt)],
);

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
 *
 * Bank-style loans (amortizationMode 'bank') layer a nullable config block
 * on top: the same ledger stores daily interest plus note-keyed 'charge'
 * component rows (seguros, otros cargos, mora) at each cuota close.
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
    /**
     * Amortization mode: null = simple tracker (monthly TNA engine,
     * unchanged); 'bank' = bank-style engine (daily EA accrual + cuota
     * components). Bank mode requires the four core config fields below
     * (gate CHECKs at the bottom of this table).
     */
    amortizationMode: loanAmortizationModeEnum("amortization_mode"),
    /** Effective annual rate actually charged (EA cobrada) in bp — THE accrual driver. 0..100000 = 0..1000%. */
    chargedRateBp: integer("charged_rate_bp"),
    /** Contractual rate (pactada) in bp — display badge ONLY, never drives math. */
    contractualRateBp: integer("contractual_rate_bp"),
    /** Loan term in months; positive. */
    termMonths: integer("term_months"),
    /** Bank-published fixed cuota in cents — authoritative (any French-derived cuota is display-only). */
    fixedCuotaCents: bigint("fixed_cuota_cents", { mode: "number" }),
    /** Calendar day the cuota closes each month (1..28, February-safe like recurring_movements). */
    cuotaDay: integer("cuota_day"),
    /** Property valuation backing the fire insurance, in cents. */
    propertyValueCents: bigint("property_value_cents", { mode: "number" }),
    /**
     * User-entered reference valor asegurado from the statement — display
     * and calibration reference ONLY. The engine never uses it for vida
     * math: vida tracks the running saldo at each period close.
     */
    insuredBaseCents: bigint("insured_base_cents", { mode: "number" }),
    /**
     * Insurance rates in PESOS PER MILLÓN × 100,000 (5 decimals):
     * 467.90 pesos-per-millón stores as 46,790,000. Basis points cannot
     * express per-millón granularity (same rationale as the money-cents
     * ceiling above). Null = component off. Charge = round(base/1e6 × rate).
     */
    lifeInsuranceRatePerMillonX100k: integer("life_insurance_rate_per_millon_x100k"),
    fireInsuranceRatePerMillonX100k: integer("fire_insurance_rate_per_millon_x100k"),
    /** Deferred slot for a future add-on insurance component; null = off. */
    extraInsuranceRatePerMillonX100k: integer("extra_insurance_rate_per_millon_x100k"),
    /** Fixed "Otros cargos" amount charged once per period, in cents. */
    otherChargesCents: bigint("other_charges_cents", { mode: "number" }),
    /** Mora (late-payment) annual rate in bp over unpaid overdue cuota components; null = no mora. */
    moraRateBp: integer("mora_rate_bp"),
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
    check(
      "loans_charged_rate_bp_bounds",
      sql`${table.chargedRateBp} IS NULL OR (${table.chargedRateBp} >= 0 AND ${table.chargedRateBp} <= 100000)`,
    ),
    check(
      "loans_contractual_rate_bp_bounds",
      sql`${table.contractualRateBp} IS NULL OR (${table.contractualRateBp} >= 0 AND ${table.contractualRateBp} <= 100000)`,
    ),
    check(
      "loans_mora_rate_bp_bounds",
      sql`${table.moraRateBp} IS NULL OR (${table.moraRateBp} >= 0 AND ${table.moraRateBp} <= 100000)`,
    ),
    check("loans_term_months_positive", sql`${table.termMonths} IS NULL OR ${table.termMonths} > 0`),
    check(
      "loans_fixed_cuota_positive",
      sql`${table.fixedCuotaCents} IS NULL OR ${table.fixedCuotaCents} > 0`,
    ),
    check(
      "loans_cuota_day_bounds",
      sql`${table.cuotaDay} IS NULL OR (${table.cuotaDay} >= 1 AND ${table.cuotaDay} <= 28)`,
    ),
    check(
      "loans_property_value_non_negative",
      sql`${table.propertyValueCents} IS NULL OR ${table.propertyValueCents} >= 0`,
    ),
    check(
      "loans_insured_base_non_negative",
      sql`${table.insuredBaseCents} IS NULL OR ${table.insuredBaseCents} >= 0`,
    ),
    check(
      "loans_other_charges_non_negative",
      sql`${table.otherChargesCents} IS NULL OR ${table.otherChargesCents} >= 0`,
    ),
    check(
      "loans_life_insurance_rate_bounds",
      sql`${table.lifeInsuranceRatePerMillonX100k} IS NULL OR (${table.lifeInsuranceRatePerMillonX100k} >= 0 AND ${table.lifeInsuranceRatePerMillonX100k} <= 999999999)`,
    ),
    check(
      "loans_fire_insurance_rate_bounds",
      sql`${table.fireInsuranceRatePerMillonX100k} IS NULL OR (${table.fireInsuranceRatePerMillonX100k} >= 0 AND ${table.fireInsuranceRatePerMillonX100k} <= 999999999)`,
    ),
    check(
      "loans_extra_insurance_rate_bounds",
      sql`${table.extraInsuranceRatePerMillonX100k} IS NULL OR (${table.extraInsuranceRatePerMillonX100k} >= 0 AND ${table.extraInsuranceRatePerMillonX100k} <= 999999999)`,
    ),
    // Amortization-mode gate: 'bank' must carry the four core config fields…
    check(
      "loans_bank_mode_requires_config",
      sql`${table.amortizationMode} IS NULL OR (${table.chargedRateBp} IS NOT NULL AND ${table.fixedCuotaCents} IS NOT NULL AND ${table.termMonths} IS NOT NULL AND ${table.cuotaDay} IS NOT NULL)`,
    ),
    // …and a simple tracker (null) must carry NO bank config at all.
    check(
      "loans_simple_mode_excludes_bank_config",
      sql`${table.amortizationMode} IS NOT NULL OR (${table.chargedRateBp} IS NULL AND ${table.contractualRateBp} IS NULL AND ${table.termMonths} IS NULL AND ${table.fixedCuotaCents} IS NULL AND ${table.cuotaDay} IS NULL AND ${table.propertyValueCents} IS NULL AND ${table.insuredBaseCents} IS NULL AND ${table.lifeInsuranceRatePerMillonX100k} IS NULL AND ${table.fireInsuranceRatePerMillonX100k} IS NULL AND ${table.extraInsuranceRatePerMillonX100k} IS NULL AND ${table.otherChargesCents} IS NULL AND ${table.moraRateBp} IS NULL)`,
    ),
  ],
);

/**
 * Loan payments ledger: 'payment' rows reduce the debt and MIRROR an expense
 * in `transactions` (paying a loan is real money leaving the household);
 * 'interest' rows are written by the lazy monthly accrual (or by admin
 * balance true-ups) and never mirror; 'charge' rows are the bank-style cuota
 * components (seguros, otros cargos, mora) written at each cuota close.
 * Engine rows ('interest'/'charge') are member-less and note-keyed.
 */
export const loanPayments = pgTable(
  "loan_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "restrict" }),
    /** null exactly for 'interest'/'charge' rows — engine entries belong to the loan, not a member. */
    memberId: uuid("member_id").references(() => users.id, { onDelete: "restrict" }),
    kind: loanPaymentKindEnum("kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    date: date("date", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Payments and charges are positive; interest is signed (a balance
    // true-up that REDUCES the debt records a negative interest entry).
    check(
      "loan_payments_amount_positive",
      sql`(${table.kind} = 'interest' AND ${table.amountCents} <> 0) OR ${table.amountCents} > 0`,
    ),
    // Engine rows ⇔ member IS NULL: payments always name a member.
    check(
      "loan_payments_engine_member_exclusive",
      sql`(${table.kind} IN ('interest', 'charge')) = (${table.memberId} IS NULL)`,
    ),
    // One engine entry per loan/day/cause (note-keyed) — makes lazy
    // concurrent catch-ups idempotent even when two requests race on the
    // same view, for daily interest AND cuota component charges alike.
    uniqueIndex("loan_payments_charge_unique")
      .on(table.loanId, table.date, table.note)
      .where(sql`${table.kind} IN ('interest', 'charge')`),
    index("loan_payments_loan_date_idx").on(table.loanId, table.date),
  ],
);

/**
 * Recurring movements: monthly transactions the app materializes by itself
 * (rent, subscriptions, salary). The lazy catch-up engine
 * (src/features/recurring/catch-up.ts) inserts one `transactions` row per
 * elapsed month on read paths; deleting a recurring keeps the already
 * generated movements (FK is SET NULL). dayOfMonth caps at 28 because
 * February is the shortest month — every month is guaranteed to have that
 * day, so no date clamping ever happens.
 */
export const recurringMovements = pgTable(
  "recurring_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    type: transactionTypeEnum("type").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    scope: scopeKindEnum("scope").notNull().default("common"),
    /** Calendar day the movement lands on each month (1..28). */
    dayOfMonth: integer("day_of_month").notNull(),
    note: text("note"),
    /** Paused recurrings stop materializing but keep their history. */
    isActive: boolean("is_active").notNull().default(true),
    /** 'YYYY-MM-01' — newest month already materialized; null = never. */
    lastMaterializedMonth: date("last_materialized_month", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("recurring_movements_amount_positive", sql`${table.amountCents} > 0`),
    check(
      "recurring_movements_day_of_month_bounds",
      sql`${table.dayOfMonth} >= 1 AND ${table.dayOfMonth} <= 28`,
    ),
  ],
);
