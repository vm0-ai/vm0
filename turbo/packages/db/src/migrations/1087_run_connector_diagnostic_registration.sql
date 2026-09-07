CREATE TABLE "agent_run_connector_diagnostic_registrations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_connector_diagnostic_registrations" ADD CONSTRAINT "agent_run_connector_diagnostic_registrations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_connector_diagnostic_registrations_created_idx" ON "agent_run_connector_diagnostic_registrations" USING btree ("created_at","run_id");