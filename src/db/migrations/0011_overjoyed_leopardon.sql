CREATE TYPE "public"."loan_amortization_mode" AS ENUM('bank');--> statement-breakpoint
ALTER TYPE "public"."loan_payment_kind" ADD VALUE 'charge';--> statement-breakpoint
ALTER TABLE "loan_payments" DROP CONSTRAINT "loan_payments_interest_member_exclusive";--> statement-breakpoint
DROP INDEX "loan_payments_interest_unique";--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "amortization_mode" "loan_amortization_mode";--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "charged_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "contractual_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "term_months" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "fixed_cuota_cents" bigint;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "cuota_day" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "property_value_cents" bigint;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "insured_base_cents" bigint;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "life_insurance_rate_per_millon_x100k" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "fire_insurance_rate_per_millon_x100k" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "extra_insurance_rate_per_millon_x100k" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "other_charges_cents" bigint;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "mora_rate_bp" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_payments_charge_unique" ON "loan_payments" USING btree ("loan_id","date","note") WHERE "loan_payments"."kind" IN ('interest', 'charge');--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_engine_member_exclusive" CHECK (("loan_payments"."kind" IN ('interest', 'charge')) = ("loan_payments"."member_id" IS NULL));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_charged_rate_bp_bounds" CHECK ("loans"."charged_rate_bp" IS NULL OR ("loans"."charged_rate_bp" >= 0 AND "loans"."charged_rate_bp" <= 100000));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_contractual_rate_bp_bounds" CHECK ("loans"."contractual_rate_bp" IS NULL OR ("loans"."contractual_rate_bp" >= 0 AND "loans"."contractual_rate_bp" <= 100000));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_mora_rate_bp_bounds" CHECK ("loans"."mora_rate_bp" IS NULL OR ("loans"."mora_rate_bp" >= 0 AND "loans"."mora_rate_bp" <= 100000));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_term_months_positive" CHECK ("loans"."term_months" IS NULL OR "loans"."term_months" > 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_fixed_cuota_positive" CHECK ("loans"."fixed_cuota_cents" IS NULL OR "loans"."fixed_cuota_cents" > 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_cuota_day_bounds" CHECK ("loans"."cuota_day" IS NULL OR ("loans"."cuota_day" >= 1 AND "loans"."cuota_day" <= 28));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_property_value_non_negative" CHECK ("loans"."property_value_cents" IS NULL OR "loans"."property_value_cents" >= 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_insured_base_non_negative" CHECK ("loans"."insured_base_cents" IS NULL OR "loans"."insured_base_cents" >= 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_other_charges_non_negative" CHECK ("loans"."other_charges_cents" IS NULL OR "loans"."other_charges_cents" >= 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_life_insurance_rate_bounds" CHECK ("loans"."life_insurance_rate_per_millon_x100k" IS NULL OR ("loans"."life_insurance_rate_per_millon_x100k" >= 0 AND "loans"."life_insurance_rate_per_millon_x100k" <= 999999999));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_fire_insurance_rate_bounds" CHECK ("loans"."fire_insurance_rate_per_millon_x100k" IS NULL OR ("loans"."fire_insurance_rate_per_millon_x100k" >= 0 AND "loans"."fire_insurance_rate_per_millon_x100k" <= 999999999));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_extra_insurance_rate_bounds" CHECK ("loans"."extra_insurance_rate_per_millon_x100k" IS NULL OR ("loans"."extra_insurance_rate_per_millon_x100k" >= 0 AND "loans"."extra_insurance_rate_per_millon_x100k" <= 999999999));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_bank_mode_requires_config" CHECK ("loans"."amortization_mode" IS NULL OR ("loans"."charged_rate_bp" IS NOT NULL AND "loans"."fixed_cuota_cents" IS NOT NULL AND "loans"."term_months" IS NOT NULL AND "loans"."cuota_day" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_simple_mode_excludes_bank_config" CHECK ("loans"."amortization_mode" IS NOT NULL OR ("loans"."charged_rate_bp" IS NULL AND "loans"."contractual_rate_bp" IS NULL AND "loans"."term_months" IS NULL AND "loans"."fixed_cuota_cents" IS NULL AND "loans"."cuota_day" IS NULL AND "loans"."property_value_cents" IS NULL AND "loans"."insured_base_cents" IS NULL AND "loans"."life_insurance_rate_per_millon_x100k" IS NULL AND "loans"."fire_insurance_rate_per_millon_x100k" IS NULL AND "loans"."extra_insurance_rate_per_millon_x100k" IS NULL AND "loans"."other_charges_cents" IS NULL AND "loans"."mora_rate_bp" IS NULL));