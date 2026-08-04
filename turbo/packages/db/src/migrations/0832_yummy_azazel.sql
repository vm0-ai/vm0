CREATE TABLE "slack_workflow_automation_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"message_ts" varchar(32) NOT NULL,
	"thread_ts" varchar(32),
	"sender_slack_user_id" varchar(255) NOT NULL,
	"owner_slack_user_id" varchar(255) NOT NULL,
	"subtype" varchar(32),
	"normalized_text" text NOT NULL,
	"shared_channel" boolean DEFAULT false NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_slack_workflow_delivery_status" CHECK ("slack_workflow_automation_deliveries"."status" IN ('pending', 'processing', 'processed', 'skipped', 'failed')),
	CONSTRAINT "chk_slack_workflow_delivery_attempts" CHECK ("slack_workflow_automation_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "slack_workflow_automation_deliveries" ADD CONSTRAINT "slack_workflow_automation_deliveries_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_workflow_delivery_message_unique" ON "slack_workflow_automation_deliveries" USING btree ("automation_id","workspace_id","channel_id","message_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_workflow_delivery_event_unique" ON "slack_workflow_automation_deliveries" USING btree ("automation_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_slack_workflow_delivery_retry" ON "slack_workflow_automation_deliveries" USING btree ("status","updated_at");