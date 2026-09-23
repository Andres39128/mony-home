CREATE TABLE "recurring_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "transaction_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"category_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"scope" "scope_kind" DEFAULT 'common' NOT NULL,
	"day_of_month" integer NOT NULL,
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_materialized_month" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_movements_amount_positive" CHECK ("recurring_movements"."amount_cents" > 0),
	CONSTRAINT "recurring_movements_day_of_month_bounds" CHECK ("recurring_movements"."day_of_month" >= 1 AND "recurring_movements"."day_of_month" <= 28)
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurring_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD CONSTRAINT "recurring_movements_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_movements" ADD CONSTRAINT "recurring_movements_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_id_recurring_movements_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_movements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_recurring_id_idx" ON "transactions" USING btree ("recurring_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_recurring_id_date_unique" ON "transactions" USING btree ("recurring_id","date") WHERE "transactions"."recurring_id" IS NOT NULL;