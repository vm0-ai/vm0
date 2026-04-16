CREATE TABLE "connector_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"flow_id" varchar(100) NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector" varchar(50) NOT NULL,
	"category" varchar(100) NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "connector_billing" ADD CONSTRAINT "connector_billing_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connector_billing_run_flow_category" ON "connector_billing" USING btree ("run_id","flow_id","category");--> statement-breakpoint
CREATE INDEX "idx_connector_billing_run_id" ON "connector_billing" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_connector_billing_org_status" ON "connector_billing" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_connector_billing_org_created" ON "connector_billing" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_connector_billing_org_user_status_processed" ON "connector_billing" USING btree ("org_id","user_id","status","processed_at");