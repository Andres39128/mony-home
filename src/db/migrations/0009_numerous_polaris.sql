CREATE TABLE "login_ip_attempts" (
	"ip" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_ip_attempts_ip_attempted_at_idx" ON "login_ip_attempts" USING btree ("ip","attempted_at");--> statement-breakpoint
-- Hand-added (drizzle does not emit data fixes): the app enforced one receipt
-- per movement in service code only, so historical duplicates may exist and
-- would make the UNIQUE below fail on deploy. Keep the newest row per
-- movement; (created_at, id) tiebreak keeps the choice deterministic.
DELETE FROM "movement_receipts" AS a
USING "movement_receipts" AS b
WHERE a."transaction_id" = b."transaction_id"
  AND (a."created_at", a."id") < (b."created_at", b."id");--> statement-breakpoint
ALTER TABLE "movement_receipts" ADD CONSTRAINT "movement_receipts_transaction_id_unique" UNIQUE("transaction_id");
