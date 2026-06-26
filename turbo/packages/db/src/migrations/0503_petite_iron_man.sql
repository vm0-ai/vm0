CREATE TABLE "zero_workflow_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"delivery_key" text NOT NULL,
	"body_sha256" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"run_id" uuid,
	"error_message" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zero_workflow_webhook_triggers" (
	"trigger_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_last_four" varchar(4) NOT NULL,
	"last_received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" ADD CONSTRAINT "zero_workflow_webhook_deliveries_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_triggers" ADD CONSTRAINT "zero_workflow_webhook_triggers_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_webhook_deliveries_key" ON "zero_workflow_webhook_deliveries" USING btree ("trigger_id","delivery_key");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_webhook_deliveries_received" ON "zero_workflow_webhook_deliveries" USING btree ("trigger_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_webhook_triggers_token_hash" ON "zero_workflow_webhook_triggers" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK ((
            kind = 'schedule'
            AND event_type IS NULL
            AND event_config IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type IN ('gmail-new-message', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));