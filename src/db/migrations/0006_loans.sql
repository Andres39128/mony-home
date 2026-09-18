CREATE TYPE "public"."loan_kind" AS ENUM('credit_card', 'investment_line', 'mortgage', 'other');--> statement-breakpoint
CREATE TYPE "public"."loan_payment_kind" AS ENUM('payment', 'interest');--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" "loan_payment_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" date DEFAULT CURRENT_DATE NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_payments_amount_positive" CHECK (("loan_payments"."kind" = 'interest' AND "loan_payments"."amount_cents" <> 0) OR "loan_payments"."amount_cents" > 0),
	CONSTRAINT "loan_payments_interest_member_exclusive" CHECK (("loan_payments"."kind" = 'interest') = ("loan_payments"."member_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "loan_kind" NOT NULL,
	"entity" text NOT NULL,
	"scope" "scope_kind" DEFAULT 'common' NOT NULL,
	"member_id" uuid,
	"principal_cents" bigint NOT NULL,
	"annual_rate_bp" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_individual_requires_member" CHECK ("loans"."scope" <> 'individual' OR "loans"."member_id" IS NOT NULL),
	CONSTRAINT "loans_principal_positive" CHECK ("loans"."principal_cents" > 0),
	CONSTRAINT "loans_annual_rate_bp_bounds" CHECK ("loans"."annual_rate_bp" IS NULL OR ("loans"."annual_rate_bp" >= 0 AND "loans"."annual_rate_bp" <= 100000))
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "loan_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_payments_interest_unique" ON "loan_payments" USING btree ("loan_id","date","note") WHERE "loan_payments"."kind" = 'interest';--> statement-breakpoint
CREATE INDEX "loan_payments_loan_date_idx" ON "loan_payments" USING btree ("loan_id","date");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_loan_payment_id_loan_payments_id_fk" FOREIGN KEY ("loan_payment_id") REFERENCES "public"."loan_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_loan_payment_id_idx" ON "transactions" USING btree ("loan_payment_id");