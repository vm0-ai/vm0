CREATE TABLE "scope_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"timezone" varchar(50),
	"notify_email" boolean DEFAULT false NOT NULL,
	"notify_slack" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "scopes" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "variables" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "scope_members" ADD CONSTRAINT "scope_members_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scope_members_scope_user" ON "scope_members" USING btree ("scope_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_scope_members_scope" ON "scope_members" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "idx_scope_members_user" ON "scope_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Backfill: create scope_members from existing scopes (one owner per scope)
INSERT INTO scope_members (id, scope_id, user_id, role, timezone, notify_email, notify_slack, created_at, updated_at)
SELECT gen_random_uuid(), id, owner_id, 'owner', timezone, notify_email, notify_slack, created_at, now()
FROM scopes WHERE owner_id IS NOT NULL;--> statement-breakpoint

-- Backfill: create scope_members from org_access_tokens (for org members)
INSERT INTO scope_members (id, scope_id, user_id, role, created_at, updated_at)
SELECT DISTINCT ON (scope_id, user_id)
  gen_random_uuid(), scope_id, user_id, role, created_at, now()
FROM org_access_tokens
ORDER BY scope_id, user_id, created_at DESC
ON CONFLICT (scope_id, user_id) DO NOTHING;--> statement-breakpoint

-- Backfill: set userId on resource tables from scope owner
UPDATE secrets s SET user_id = sc.owner_id FROM scopes sc WHERE s.scope_id = sc.id;--> statement-breakpoint
UPDATE variables v SET user_id = sc.owner_id FROM scopes sc WHERE v.scope_id = sc.id;--> statement-breakpoint
UPDATE connectors c SET user_id = sc.owner_id FROM scopes sc WHERE c.scope_id = sc.id;--> statement-breakpoint
UPDATE model_providers mp SET user_id = sc.owner_id FROM scopes sc WHERE mp.scope_id = sc.id;--> statement-breakpoint

-- Backfill: set scopeId on agent_runs via compose chain
UPDATE agent_runs ar SET scope_id = ac.scope_id
FROM agent_compose_versions acv
JOIN agent_composes ac ON acv.compose_id = ac.id
WHERE ar.agent_compose_version_id = acv.id;--> statement-breakpoint

-- Backfill: copy ownerId to createdBy
UPDATE scopes SET created_by = owner_id;