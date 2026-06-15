ALTER TABLE "zero_agents" ADD COLUMN "owner" text;
--> statement-breakpoint
UPDATE "zero_agents" SET "owner" = "agent_composes"."user_id" FROM "agent_composes" WHERE "zero_agents"."id" = "agent_composes"."id";
--> statement-breakpoint
DELETE FROM "zero_agents" WHERE "owner" IS NULL;
--> statement-breakpoint
ALTER TABLE "zero_agents" ALTER COLUMN "owner" SET NOT NULL;
