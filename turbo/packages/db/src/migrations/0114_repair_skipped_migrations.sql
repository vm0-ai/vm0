-- Repair migration: apply changes that were skipped due to out-of-order
-- timestamps in migrations 0113-0115 (consolidated into 0113_handy_galactus).
-- All statements use idempotent guards so this is safe on both fresh
-- databases (where 0113 already applied everything) and on production
-- (where only the original 0113_storage_user_scope_isolation ran).

-- 1. Create email_outbox table (from original 0114_absurd_thundra)
CREATE TABLE IF NOT EXISTS "email_outbox" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_outbox_drain_idx" ON "email_outbox" USING btree ("status","next_retry_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_created_at_idx" ON "email_outbox" USING btree ("created_at");--> statement-breakpoint

-- 2. Agent schedules scope/user columns (from original 0115_wealthy_malice)
DROP INDEX IF EXISTS "idx_agent_schedules_compose_name";--> statement-breakpoint

ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint

-- Backfill from compose (idempotent: overwrites with same values if already set)
UPDATE agent_schedules s
SET scope_id = c.scope_id, user_id = c.user_id
FROM agent_composes c
WHERE s.compose_id = c.id;--> statement-breakpoint

-- Set NOT NULL (idempotent: no-op if already NOT NULL)
ALTER TABLE "agent_schedules" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

-- Add FK constraint (skip if already exists)
DO $$ BEGIN
  ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_scope_id_scopes_id_fk"
    FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_schedules_compose_name_scope_user" ON "agent_schedules" USING btree ("compose_id","name","scope_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_schedules_scope_user" ON "agent_schedules" USING btree ("scope_id","user_id");--> statement-breakpoint

-- 3. Storages changes (from original 0113_storage_user_scope_isolation, likely already applied)
UPDATE "storages" SET "user_id" = '__scope__' WHERE "type" = 'volume' AND "user_id" != '__scope__';--> statement-breakpoint

DROP INDEX IF EXISTS "idx_storages_scope_name_type";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_storages_scope_user_name_type" ON "storages" USING btree ("scope_id","user_id","name","type");
