ALTER TABLE "budgets" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "envelopes" ALTER COLUMN "monthly_amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "savings_contributions" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "savings_goals" ALTER COLUMN "target_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "savings_goals" ALTER COLUMN "current_value_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;