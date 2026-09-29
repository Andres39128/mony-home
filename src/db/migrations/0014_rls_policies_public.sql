-- Explicit RLS policies for every public-schema table.
--
-- Migration 0013 enabled RLS on the 14 app tables but added no policies,
-- relying on the Postgres default ("RLS on + no policies = deny") to lock
-- anon/authenticated out of PostgREST. That works for SECURITY (Postgres
-- denies by default) but the Supabase Security Advisor still flags every
-- table as "RLS Enabled No Policy" because it expects explicit CREATE POLICY
-- statements. This migration adds a single deny-all policy per table to
-- silence those 15 suggestions.
--
-- Why a single policy instead of just relying on the default:
--   1. The Security Advisor wants explicit policies (otherwise 15 info-level
--      warnings remain).
--   2. If Supabase Auth is wired in later and someone adds permissive
--      policies, these explicit deny policies on anon/authenticated survive
--      and keep the lock-down intent obvious in the schema.
--
-- The `postgres` role (used by the app's direct connection via Supavisor
-- SESSION pooler) bypasses RLS by virtue of being superuser, so the app is
-- unaffected. PostgREST uses `anon`/`authenticated`, which DO NOT bypass RLS
-- and now hit an explicit USING (false) on every operation.
--
-- Each block is idempotent: DROP POLICY IF EXISTS guards against re-runs,
-- and ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op when already on.
-- __drizzle_migrations is included because Supabase auto-enabled RLS on it
-- when the table was created — same lock-down treatment as the app tables.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "users";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "users" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "sessions";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "sessions" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "categories";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "categories" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "expense_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "expense_groups";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "expense_groups" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "transactions";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "transactions" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "movement_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "movement_receipts";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "movement_receipts" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "login_ip_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "login_ip_attempts";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "login_ip_attempts" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "assistant_usage";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "assistant_usage" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "budgets";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "budgets" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "savings_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "savings_goals";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "savings_goals" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "savings_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "savings_contributions";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "savings_contributions" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "loans";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "loans" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "loan_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "loan_payments";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "loan_payments" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "recurring_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "recurring_movements";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "recurring_movements" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);--> statement-breakpoint
-- __drizzle_migrations is created by Drizzle's postgres-js migrator at runtime
-- but NOT by the PGlite migrator. Production Supabase already has the table
-- (with RLS auto-enabled by Supabase when it was created). Guard the policy
-- block behind a pg_tables lookup so the migration is portable: the block
-- only fires when the table is actually present.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '__drizzle_migrations') THEN
    EXECUTE 'ALTER TABLE "__drizzle_migrations" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "app_deny_api" ON "__drizzle_migrations"';
    EXECUTE 'CREATE POLICY "app_deny_api" ON "__drizzle_migrations" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
END
$do$
