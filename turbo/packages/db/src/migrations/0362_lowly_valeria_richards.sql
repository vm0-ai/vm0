CREATE TABLE "remote_agent_device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"poll_token_hash" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"host_name" text NOT NULL,
	"supported_backends" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"host_id" uuid,
	"claimed_at" timestamp,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_agent_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"supported_backends" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_agent_device_codes" ADD CONSTRAINT "remote_agent_device_codes_host_id_remote_agent_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."remote_agent_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_remote_agent_device_codes_code_hash" ON "remote_agent_device_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_device_codes_poll" ON "remote_agent_device_codes" USING btree ("code_hash","poll_token_hash");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_device_codes_org_user" ON "remote_agent_device_codes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_device_codes_expires" ON "remote_agent_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_remote_agent_hosts_token_hash" ON "remote_agent_hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_hosts_org_user" ON "remote_agent_hosts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_hosts_last_seen" ON "remote_agent_hosts" USING btree ("last_seen_at");