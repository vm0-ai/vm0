CREATE TABLE "zero_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_name" varchar(256),
	"description" text,
	"sound" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_agents_org_name" ON "zero_agents" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_zero_agents_org" ON "zero_agents" USING btree ("org_id");--> statement-breakpoint

-- Backfill from existing compose content JSONB
INSERT INTO "zero_agents" ("org_id", "name", "display_name", "description", "sound")
SELECT
  ac.org_id,
  ac.name,
  sub.display_name,
  sub.description,
  sub.sound
FROM agent_composes ac
JOIN agent_compose_versions acv ON ac.head_version_id = acv.id
CROSS JOIN LATERAL (
  SELECT
    (value -> 'metadata' ->> 'displayName') AS display_name,
    (value -> 'metadata' ->> 'description') AS description,
    (value -> 'metadata' ->> 'sound') AS sound
  FROM jsonb_each(acv.content -> 'agents')
  LIMIT 1
) sub
WHERE ac.head_version_id IS NOT NULL
ON CONFLICT ("org_id", "name") DO NOTHING;
