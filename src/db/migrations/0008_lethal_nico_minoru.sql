CREATE TYPE "public"."accrual_mode" AS ENUM('simple', 'compound');--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN "accrual_mode" "accrual_mode";--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN "rate_reviewed_month" date;--> statement-breakpoint
-- Existing rate-bearing goals keep their historical rate/12 semantics: 'simple'.
UPDATE "savings_goals" SET "accrual_mode" = 'simple' WHERE "annual_rate_bp" IS NOT NULL;--> statement-breakpoint
-- Sever envelope links first: historical movements keep their rows (note/category survive).
UPDATE "transactions" SET "envelope_id" = NULL;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_envelope_id_envelopes_id_fk";--> statement-breakpoint
DROP INDEX "transactions_envelope_id_idx";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "envelope_id";--> statement-breakpoint
DROP TABLE "envelopes";
