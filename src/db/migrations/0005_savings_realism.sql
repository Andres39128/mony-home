ALTER TYPE "public"."contribution_kind" ADD VALUE 'interest';--> statement-breakpoint
ALTER TABLE "savings_contributions" DROP CONSTRAINT "savings_contributions_amount_positive";--> statement-breakpoint
ALTER TABLE "savings_contributions" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN "institution" text;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN "annual_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "savings_contribution_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_savings_contribution_id_savings_contributions_id_fk" FOREIGN KEY ("savings_contribution_id") REFERENCES "public"."savings_contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "savings_contributions_interest_unique" ON "savings_contributions" USING btree ("goal_id","date","note") WHERE "savings_contributions"."kind" = 'interest';--> statement-breakpoint
CREATE INDEX "transactions_savings_contribution_id_idx" ON "transactions" USING btree ("savings_contribution_id");--> statement-breakpoint
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_interest_member_exclusive" CHECK (("savings_contributions"."kind" = 'interest') = ("savings_contributions"."member_id" IS NULL));--> statement-breakpoint
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_amount_positive" CHECK (("savings_contributions"."kind" = 'interest' AND "savings_contributions"."amount_cents" <> 0) OR "savings_contributions"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_annual_rate_bp_bounds" CHECK ("savings_goals"."annual_rate_bp" IS NULL OR ("savings_goals"."annual_rate_bp" >= 0 AND "savings_goals"."annual_rate_bp" <= 100000));