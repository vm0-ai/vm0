ALTER TABLE "agent_composes" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent_composes"
SET "is_default" = true
FROM "scopes"
WHERE "agent_composes"."id" = "scopes"."default_agent_compose_id"
  AND "scopes"."default_agent_compose_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_composes_default_per_org" ON "agent_composes" USING btree ("clerk_org_id") WHERE is_default = true;
