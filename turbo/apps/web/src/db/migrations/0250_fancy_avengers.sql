CREATE TABLE "client_credit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"result_uuid" uuid,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model" varchar(255) NOT NULL,
	"model_provider" varchar(100) DEFAULT '' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 8),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_credit_usage_run_result";--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "message_id" varchar(100);--> statement-breakpoint
ALTER TABLE "client_credit_usage" ADD CONSTRAINT "client_credit_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_credit_usage_run_result" ON "client_credit_usage" USING btree ("run_id","result_uuid");--> statement-breakpoint
CREATE INDEX "idx_client_credit_usage_run_id" ON "client_credit_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_client_credit_usage_org_created" ON "client_credit_usage" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_usage_run_message" ON "credit_usage" USING btree ("run_id","message_id");