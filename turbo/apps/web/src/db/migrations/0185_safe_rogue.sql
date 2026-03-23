ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "zero_agent_schedules_zero_agent_id_zero_agents_id_fk";
--> statement-breakpoint
DROP INDEX "idx_zero_agent_schedules_compose";--> statement-breakpoint
DROP INDEX "idx_zero_agent_schedules_compose_name_org_user";--> statement-breakpoint
DELETE FROM "zero_agent_schedules" WHERE "zero_agent_id" IS NULL;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ALTER COLUMN "zero_agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_zero_agent_id_zero_agents_id_fk" FOREIGN KEY ("zero_agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_agent_schedules_agent_name_org_user" ON "zero_agent_schedules" USING btree ("zero_agent_id","name","org_id","user_id");