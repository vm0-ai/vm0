CREATE TABLE "computer_use_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"ngrok_bot_user_id" text,
	"ngrok_credential_id" text,
	"ngrok_endpoint_id" text,
	"ngrok_domain_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_use_hosts_org_user" ON "computer_use_hosts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_computer_use_hosts_org" ON "computer_use_hosts" USING btree ("org_id");