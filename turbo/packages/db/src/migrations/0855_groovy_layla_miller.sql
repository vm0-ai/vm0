CREATE TABLE "stripe_workflow_automation_health" (
	"automation_id" uuid PRIMARY KEY NOT NULL,
	"last_matching_event_received_at" timestamp,
	"latest_delivery_id" uuid,
	"latest_delivery_status" varchar(32),
	"latest_delivery_status_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_workflow_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"stripe_account_id" varchar(255) NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_event_id" varchar(255) NOT NULL,
	"stripe_event_created_at" timestamp NOT NULL,
	"billing_reason" text,
	"snapshot" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"claim_expires_at" timestamp,
	"next_attempt_at" timestamp NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"delivered_at" timestamp,
	"skipped_at" timestamp,
	"failed_at" timestamp,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_workflow_automation_health" ADD CONSTRAINT "stripe_workflow_automation_health_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_stripe_workflow_deliveries_dedupe" ON "stripe_workflow_deliveries" USING btree ("automation_id","stripe_account_id","livemode","stripe_event_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_workflow_deliveries_due" ON "stripe_workflow_deliveries" USING btree ("next_attempt_at","claim_expires_at") WHERE "stripe_workflow_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_stripe_workflow_deliveries_automation" ON "stripe_workflow_deliveries" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_connectors_stripe_oauth_external_id" ON "connectors" USING btree ("external_id") WHERE "connectors"."connector_slug" = 'stripe' AND "connectors"."auth_method" = 'oauth';