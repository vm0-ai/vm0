CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"cc_addresses" jsonb,
	"subject" text NOT NULL,
	"reply_to" text,
	"headers" jsonb,
	"template" jsonb NOT NULL,
	"post_send_action" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp,
	"resend_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose_name";--> statement-breakpoint
DROP INDEX "idx_storages_scope_name_type";--> statement-breakpoint

-- Add scope_id and user_id as nullable first for backfill
ALTER TABLE "agent_schedules" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "user_id" text;--> statement-breakpoint

-- Backfill from compose (existing schedules use compose's scope + creator)
UPDATE agent_schedules s
SET scope_id = c.scope_id, user_id = c.user_id
FROM agent_composes c
WHERE s.compose_id = c.id;--> statement-breakpoint

-- Make NOT NULL after backfill
ALTER TABLE "agent_schedules" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

-- Set sentinel userId on all existing volumes (scope-level shared resources)
UPDATE "storages" SET "user_id" = '__scope__' WHERE "type" = 'volume';--> statement-breakpoint

CREATE INDEX "email_outbox_drain_idx" ON "email_outbox" USING btree ("status","next_retry_at","created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_created_at_idx" ON "email_outbox" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_schedules_compose_name_scope_user" ON "agent_schedules" USING btree ("compose_id","name","scope_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_scope_user" ON "agent_schedules" USING btree ("scope_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storages_scope_user_name_type" ON "storages" USING btree ("scope_id","user_id","name","type");
