CREATE TABLE "banking_access_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"connection_id" uuid,
	"provider" varchar(32) DEFAULT 'finicity' NOT NULL,
	"provider_account_id" varchar(128),
	"action" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"failure_code" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banking_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_account_id" varchar(128) NOT NULL,
	"display_name" varchar(256),
	"institution_name" varchar(256),
	"account_type" varchar(64),
	"account_number_last4" varchar(8),
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banking_agent_enablements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_provider_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"operation_scopes" jsonb DEFAULT '["accounts.read","balances.read","transactions.read"]'::jsonb NOT NULL,
	"allow_scheduled_runs" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banking_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(32) DEFAULT 'finicity' NOT NULL,
	"provider_customer_id" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"consent_expires_at" timestamp,
	"repair_required_at" timestamp,
	"revoked_at" timestamp,
	"deleted_at" timestamp,
	"audit_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "banking_accounts" ADD CONSTRAINT "banking_accounts_connection_id_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."banking_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" ADD CONSTRAINT "banking_agent_enablements_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" ADD CONSTRAINT "banking_agent_enablements_connection_id_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."banking_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_banking_access_audit_org_user" ON "banking_access_audit_events" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_banking_access_audit_run" ON "banking_access_audit_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_banking_access_audit_created" ON "banking_access_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_banking_accounts_connection_provider_account" ON "banking_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_banking_accounts_org_user" ON "banking_accounts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_banking_agent_enablements_unique" ON "banking_agent_enablements" USING btree ("org_id","user_id","agent_id","connection_id");--> statement-breakpoint
CREATE INDEX "idx_banking_agent_enablements_agent_user" ON "banking_agent_enablements" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_banking_connections_owner_provider" ON "banking_connections" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_banking_connections_org_user" ON "banking_connections" USING btree ("org_id","user_id");