import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Database schema for mony-home — single source of truth.
 *
 * Conventions:
 * - All primary keys are `uuid().defaultRandom()`.
 * - All tables carry `created_at timestamptz default now()`.
 * - Column names are explicit snake_case; TS keys stay camelCase.
 * - Money is ALWAYS integer cents (never floats, never numeric columns).
 * - "común" scope is stored as 'common'.
 */

export const roleEnum = pgEnum("role", ["admin", "member"]);
export const categoryKindEnum = pgEnum("category_kind", ["income", "expense"]);
export const transactionTypeEnum = pgEnum("transaction_type", ["income", "expense"]);
export const scopeKindEnum = pgEnum("scope_kind", ["individual", "common"]);
export const groupStatusEnum = pgEnum("group_status", ["active", "closed"]);

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

export const envelopes = pgTable(
  "envelopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    scope: scopeKindEnum("scope").notNull(),
    /** null = common/shared envelope; required when scope is 'individual'. */
    memberId: uuid("member_id").references(() => users.id),
    monthlyAmountCents: integer("monthly_amount_cents").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "envelopes_individual_requires_member",
      sql`${table.scope} <> 'individual' OR ${table.memberId} IS NOT NULL`,
    ),
  ],
);

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
    amountCents: integer("amount_cents").notNull(),
    type: transactionTypeEnum("type").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    envelopeId: uuid("envelope_id").references(() => envelopes.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").references(() => expenseGroups.id, { onDelete: "set null" }),
    scope: scopeKindEnum("scope").notNull().default("common"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("transactions_amount_positive", sql`${table.amountCents} > 0`),
    index("transactions_date_idx").on(table.date),
    index("transactions_category_id_idx").on(table.categoryId),
    index("transactions_member_id_idx").on(table.memberId),
    index("transactions_envelope_id_idx").on(table.envelopeId),
    index("transactions_group_id_idx").on(table.groupId),
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
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("budgets_month_category_id_unique").on(table.month, table.categoryId),
    check("budgets_amount_non_negative", sql`${table.amountCents} >= 0`),
    index("budgets_month_idx").on(table.month),
  ],
);
