-- App-wide configuration key/value store (roadmap F1: parametrizable
-- currency/locale).
--
-- Two rows seeded by `npm run db:seed` (currencyCode/locale from the
-- APP_CURRENCY/APP_LOCALE env vars), editable later from the admin
-- Configuración page via src/lib/app-settings.ts. There is no user column:
-- settings are instance-global for the single household this app serves.
--
-- Same lock-down treatment as every public table (0013/0014): RLS enabled
-- plus an explicit deny-all policy so the PostgREST surface (anon/
-- authenticated) exposes nothing, while the app's direct superuser
-- connection bypasses RLS and keeps full read/write access.
CREATE TABLE "app_config" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "app_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_deny_api" ON "app_config";--> statement-breakpoint
CREATE POLICY "app_deny_api" ON "app_config" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
