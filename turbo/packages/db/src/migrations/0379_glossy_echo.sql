CREATE TABLE "local_browser_command_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"host_id" uuid,
	"tab_id" text,
	"kind" text NOT NULL,
	"target_url" text,
	"event" text NOT NULL,
	"approval_outcome" text,
	"redacted_result" jsonb,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_browser_command_audit_events" ADD CONSTRAINT "local_browser_command_audit_events_command_id_local_browser_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."local_browser_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_browser_command_audit_events" ADD CONSTRAINT "local_browser_command_audit_events_host_id_local_browser_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."local_browser_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_local_browser_command_audit_command" ON "local_browser_command_audit_events" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "idx_local_browser_command_audit_org_user" ON "local_browser_command_audit_events" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_local_browser_command_audit_created" ON "local_browser_command_audit_events" USING btree ("created_at");