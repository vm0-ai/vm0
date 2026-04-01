ALTER TABLE "zero_agents" ADD COLUMN "owner" text;
--> statement-breakpoint
UPDATE "zero_agents" SET "owner" = "agent_composes"."user_id" FROM "agent_composes" WHERE "zero_agents"."id" = "agent_composes"."id";