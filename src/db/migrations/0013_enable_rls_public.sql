-- Enable Row Level Security on every public-schema table.
--
-- Why: the Supabase Security Advisor reports "RLS Disabled in Public" for every
-- public table because PostgREST (https://<ref>.supabase.co/rest/v1/...) exposes
-- the public schema to anyone holding the project's anon key. The app itself
-- never calls PostgREST — it connects directly via postgres.js to the Supavisor
-- SESSION pooler (port 5432) using the `postgres` role (superuser), which
-- ALWAYS bypasses RLS. So enabling RLS here:
--
--   1. Closes the PostgREST attack surface (anon/authenticated get zero rows).
--   2. Does NOT touch the app's direct connection (superuser bypass).
--   3. Is the standard Supabase recommendation; clears all 14 advisor entries.
--
-- No policies are added because the Postgres default when RLS is enabled and no
-- policy matches is to deny access for non-bypassing roles — that's exactly what
-- we want for anon/authenticated. If Supabase Auth is added later, write
-- permissive policies explicitly (CREATE POLICY ... TO authenticated ...).
--
-- We deliberately do NOT use ALTER TABLE ... FORCE ROW LEVEL SECURITY: the
-- direct-connection role is the table owner in some setups, and FORCE would
-- make the app subject to policies even though we want it to bypass.
--
-- Tables (14, matches src/db/schema.ts and the Security Advisor screenshot):
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expense_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "movement_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "login_ip_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "savings_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "savings_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_movements" ENABLE ROW LEVEL SECURITY;
