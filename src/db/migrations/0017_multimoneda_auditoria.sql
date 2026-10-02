-- Roadmap F8 (foreign-currency investments) + F9 (audit trail) in ONE
-- migration (odd/tasks/roadmap-completitud.md, decisions 8-9).
--
-- savings_goals.currency: which currency the investment's current value is
-- DENOMINATED in. Empty string ('') = the household's base currency
-- (app_config.currencyCode) — the historical state of every existing row,
-- kept as the default so no backfill is needed. A dedicated enum was
-- overkill for one optional free-form field; the CHECK keeps the value
-- either empty or an uppercase 3-letter code (ISO-4217-style; stablecoin
-- codes like USDT are allowed on purpose — real investments in this
-- region). The "investments only" rule lives in the savings service, not
-- SQL: kind and currency change together through one form, so the
-- app-level invariant is enforced where both fields arrive.
--
-- audit_log: append-only trail of household mutations (F9). entity_id is
-- text (not uuid) because creates log before an id is handy and imports
-- log batch-level rows. actor_id RESTRICTs: an audit row must never
-- outlive its actor, and an actor with history must never be silently
-- deleted. Same lock-down treatment as every public table (0013/0014):
-- RLS enabled plus an explicit deny-all policy so the PostgREST surface
-- exposes nothing, while the app's direct superuser connection bypasses
-- RLS and keeps full read/write access.
ALTER TABLE "savings_goals" ADD COLUMN "currency" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_currency_shape" CHECK ("currency" = '' OR "currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "entity" text NOT NULL,
  "entity_id" text NOT NULL,
  "action" text NOT NULL,
  "summary" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "audit_log_created_at_index" ON "audit_log" ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_entity_entity_id_index" ON "audit_log" ("entity","entity_id");--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_deny_api" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_deny_api" ON "audit_log" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
