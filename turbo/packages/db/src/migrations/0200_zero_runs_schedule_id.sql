ALTER TABLE "zero_runs" ADD COLUMN "schedule_id" uuid;
--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_schedule_id_zero_agent_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."zero_agent_schedules"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "zero_runs"
SET "schedule_id" = "agent_runs"."schedule_id"
FROM "agent_runs"
WHERE "zero_runs"."id" = "agent_runs"."id";
--> statement-breakpoint
CREATE INDEX "idx_zero_runs_schedule" ON "zero_runs" USING btree ("schedule_id") WHERE schedule_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX "idx_agent_runs_schedule_created";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_schedule_id_zero_agent_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "schedule_id";
