-- Recurring frequencies (monthly/weekly/annual) + card-paid recurrings
-- (roadmap F3).
--
-- frequency defaults 'monthly' — the pre-0016 behavior for every existing
-- row. The payment columns mirror the transactions card pattern (0012):
-- payment_method ⇔ card_loan_id is ONE atomic fact enforced by CHECK, and
-- only expenses may ride a card. RESTRICT on card_loan_id: a card with
-- recurrings attached cannot be deleted (it would silently falsify what
-- funds them) — deactivate it instead.
--
-- RLS is untouched: recurring_movements already carries ENABLE RLS plus a
-- deny-all policy (0013/0014), and ALTER TABLE does not reset it.
CREATE TYPE "public"."recurring_frequency" AS ENUM('monthly', 'weekly', 'annual');--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD COLUMN "frequency" "recurring_frequency" DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD COLUMN "payment_method" "payment_method" DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD COLUMN "card_loan_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD CONSTRAINT "recurring_movements_card_loan_id_loans_id_fk" FOREIGN KEY ("card_loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD CONSTRAINT "recurring_movements_card_matches_loan" CHECK (("recurring_movements"."payment_method" = 'card') = ("recurring_movements"."card_loan_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD CONSTRAINT "recurring_movements_card_expense_only" CHECK ("recurring_movements"."payment_method" = 'cash' OR "recurring_movements"."type" = 'expense');
