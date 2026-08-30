CREATE TABLE "banking_connect_events" (
	"event_id" varchar(128) PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"end_reason" varchar(64),
	"provider_occurred_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banking_connect_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"mode" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"institution_login_id" varchar(128),
	"added_at" timestamp,
	"done_at" timestamp,
	"completed_at" timestamp,
	"end_reason" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "banking_accounts" ADD COLUMN "institution_login_id" varchar(128);--> statement-breakpoint
ALTER TABLE "banking_accounts" ADD COLUMN "repair_required_at" timestamp;--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "banking_connect_events" ADD CONSTRAINT "banking_connect_events_session_id_banking_connect_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."banking_connect_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banking_connect_sessions" ADD CONSTRAINT "banking_connect_sessions_connection_id_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."banking_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_banking_connect_events_session" ON "banking_connect_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_banking_connect_sessions_owner" ON "banking_connect_sessions" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_banking_connect_sessions_connection" ON "banking_connect_sessions" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_banking_connect_sessions_one_pending" ON "banking_connect_sessions" USING btree ("connection_id") WHERE "banking_connect_sessions"."status" = 'pending';