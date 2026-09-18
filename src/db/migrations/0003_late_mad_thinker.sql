CREATE TYPE "public"."contribution_kind" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."savings_kind" AS ENUM('savings', 'investment');--> statement-breakpoint
CREATE TABLE "savings_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "contribution_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"date" date DEFAULT CURRENT_DATE NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_contributions_amount_positive" CHECK ("savings_contributions"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "savings_kind" DEFAULT 'savings' NOT NULL,
	"scope" "scope_kind" DEFAULT 'common' NOT NULL,
	"member_id" uuid,
	"target_cents" integer,
	"deadline" date,
	"current_value_cents" integer,
	"value_updated_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_goals_individual_requires_member" CHECK ("savings_goals"."scope" <> 'individual' OR "savings_goals"."member_id" IS NOT NULL),
	CONSTRAINT "savings_goals_target_non_negative" CHECK ("savings_goals"."target_cents" IS NULL OR "savings_goals"."target_cents" >= 0),
	CONSTRAINT "savings_goals_current_value_non_negative" CHECK ("savings_goals"."current_value_cents" IS NULL OR "savings_goals"."current_value_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "savings_contributions_goal_date_idx" ON "savings_contributions" USING btree ("goal_id","date");