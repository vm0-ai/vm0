ALTER TABLE "zero_agent_schedules" ADD COLUMN "zero_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_zero_agent_id_zero_agents_id_fk" FOREIGN KEY ("zero_agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_agent_schedules_zero_agent" ON "zero_agent_schedules" USING btree ("zero_agent_id");--> statement-breakpoint
UPDATE "zero_agent_schedules" s
SET "zero_agent_id" = z.id
FROM "agent_composes" c
JOIN "zero_agents" z ON z."org_id" = c."org_id" AND z."name" = c."name"
WHERE s."compose_id" = c.id
AND s."zero_agent_id" IS NULL;
