CREATE TABLE "movement_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"mime_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_amount_positive";--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "needs_details" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "movement_receipts" ADD CONSTRAINT "movement_receipts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_completed_amount_positive" CHECK ("transactions"."needs_details" OR "transactions"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_completed_category_present" CHECK ("transactions"."needs_details" OR "transactions"."category_id" IS NOT NULL);