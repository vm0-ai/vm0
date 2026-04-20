ALTER TABLE "org_metadata" ADD COLUMN "default_agent_id" uuid;--> statement-breakpoint

UPDATE "org_metadata" m
SET "default_agent_id" = z."id"
FROM "agent_composes" c
INNER JOIN "zero_agents" z ON z."org_id" = c."org_id" AND z."name" = c."name"
WHERE m."default_agent_compose_id" = c."id" AND m."default_agent_id" IS NULL;--> statement-breakpoint

ALTER TABLE "org_metadata" ADD CONSTRAINT "org_metadata_default_agent_id_zero_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "org_metadata" DROP COLUMN "default_agent_compose_id";
