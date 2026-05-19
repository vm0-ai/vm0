DELETE FROM "computer_use_hosts";--> statement-breakpoint
CREATE TABLE "computer_use_command_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"host_id" uuid,
	"kind" text NOT NULL,
	"app" text,
	"event" text NOT NULL,
	"approval_outcome" text,
	"redacted_result" jsonb,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_use_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"host_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"timeout_ms" integer,
	"claimed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_computer_use_hosts_org";--> statement-breakpoint
DROP INDEX "idx_computer_use_hosts_org_user";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "display_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "app_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "os_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "supported_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "permissions" jsonb DEFAULT '{"accessibility":false,"screenRecording":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "status" text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "last_seen_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "computer_use_command_audit_events" ADD CONSTRAINT "computer_use_command_audit_events_command_id_computer_use_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."computer_use_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_use_command_audit_events" ADD CONSTRAINT "computer_use_command_audit_events_host_id_computer_use_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."computer_use_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_use_commands" ADD CONSTRAINT "computer_use_commands_host_id_computer_use_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."computer_use_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_use_command_audit_command" ON "computer_use_command_audit_events" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "idx_computer_use_command_audit_org_user" ON "computer_use_command_audit_events" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_computer_use_command_audit_created" ON "computer_use_command_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_computer_use_commands_host_status" ON "computer_use_commands" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "idx_computer_use_commands_org_user" ON "computer_use_commands" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_computer_use_commands_created" ON "computer_use_commands" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_use_hosts_token_hash" ON "computer_use_hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_computer_use_hosts_last_seen" ON "computer_use_hosts" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_computer_use_hosts_org_user" ON "computer_use_hosts" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "domain";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "ngrok_bot_user_id";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "ngrok_credential_id";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "ngrok_endpoint_id";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "ngrok_domain_id";--> statement-breakpoint
ALTER TABLE "computer_use_hosts" DROP COLUMN "expires_at";
