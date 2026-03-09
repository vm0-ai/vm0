-- Add scope_id and user_id to agent_schedules for cross-scope sharing support
-- Schedules need their own scope+user identity separate from the compose

DROP INDEX "idx_agent_schedules_compose_name";--> statement-breakpoint

-- Add as nullable first for backfill
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

ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_schedules_compose_name_scope_user" ON "agent_schedules" USING btree ("compose_id","name","scope_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_scope_user" ON "agent_schedules" USING btree ("scope_id","user_id");
