CREATE TABLE "model_stat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hour_start" timestamp NOT NULL,
	"model" varchar(255) NOT NULL,
	"model_provider" varchar(100) DEFAULT '' NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"org_count" integer DEFAULT 0 NOT NULL,
	"user_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"credits_charged" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_stat_hour_model_provider" ON "model_stat" USING btree ("hour_start","model","model_provider");--> statement-breakpoint
CREATE INDEX "idx_model_stat_hour_start" ON "model_stat" USING btree ("hour_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_model_stat_model_hour" ON "model_stat" USING btree ("model","hour_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_credit_usage_created_at" ON "credit_usage" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_usage_event_model_created" ON "usage_event" USING btree ("created_at" DESC NULLS LAST) WHERE "usage_event"."kind" = 'model';