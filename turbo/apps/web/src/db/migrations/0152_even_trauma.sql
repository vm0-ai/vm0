CREATE TABLE "credit_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_token_price" bigint NOT NULL,
	"output_token_price" bigint NOT NULL,
	"turn_price" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"credits_charged" bigint,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "org_cache" ADD COLUMN "credits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD CONSTRAINT "credit_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_pricing_model" ON "credit_pricing" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_usage_run_id" ON "credit_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_org_status" ON "credit_usage" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_org_created" ON "credit_usage" USING btree ("org_id","created_at" DESC NULLS LAST);