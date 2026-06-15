CREATE TABLE "proxy_credit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model" varchar(255) NOT NULL,
	"model_provider" varchar(100) DEFAULT '' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_proxy_credit_usage_run_id" ON "proxy_credit_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_proxy_credit_usage_org_created" ON "proxy_credit_usage" USING btree ("org_id","created_at");