CREATE TABLE "usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(30) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"category" varchar(100) NOT NULL,
	"quantity" bigint NOT NULL,
	"credits_charged" bigint,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
DROP TABLE "connector_billing" CASCADE;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_event_idempotency_key" ON "usage_event" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_usage_event_run_id" ON "usage_event" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_org_status" ON "usage_event" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_event_org_created" ON "usage_event" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_usage_event_org_user_status_processed" ON "usage_event" USING btree ("org_id","user_id","status","processed_at");