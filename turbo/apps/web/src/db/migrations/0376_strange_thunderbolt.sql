CREATE TABLE "local_browser_commands" (
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
CREATE TABLE "local_browser_device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"poll_token_hash" text NOT NULL,
	"org_id" text,
	"user_id" text,
	"host_name" text NOT NULL,
	"browser" text NOT NULL,
	"extension_version" text NOT NULL,
	"supported_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"host_id" uuid,
	"claimed_at" timestamp,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_browser_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"browser" text NOT NULL,
	"extension_version" text NOT NULL,
	"supported_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_browser_commands" ADD CONSTRAINT "local_browser_commands_host_id_local_browser_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."local_browser_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_browser_device_codes" ADD CONSTRAINT "local_browser_device_codes_host_id_local_browser_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."local_browser_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_local_browser_commands_host_status" ON "local_browser_commands" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "idx_local_browser_commands_org_user" ON "local_browser_commands" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_local_browser_commands_created" ON "local_browser_commands" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_local_browser_device_codes_code_hash" ON "local_browser_device_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_local_browser_device_codes_poll" ON "local_browser_device_codes" USING btree ("code_hash","poll_token_hash");--> statement-breakpoint
CREATE INDEX "idx_local_browser_device_codes_org_user" ON "local_browser_device_codes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_local_browser_device_codes_expires" ON "local_browser_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_local_browser_hosts_token_hash" ON "local_browser_hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_local_browser_hosts_org_user" ON "local_browser_hosts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_local_browser_hosts_last_seen" ON "local_browser_hosts" USING btree ("last_seen_at");