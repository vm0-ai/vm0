ALTER TABLE "agent_schedules" RENAME TO "zero_agent_schedules";--> statement-breakpoint
ALTER INDEX "agent_schedules_pkey" RENAME TO "zero_agent_schedules_pkey";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_schedule_id_agent_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "agent_schedules_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "agent_schedules_last_run_id_agent_runs_id_fk";
--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_org";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose_name_org_user";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_next_run";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_schedule_id_zero_agent_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."zero_agent_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_compose_id_agent_composes_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_last_run_id_agent_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_agent_schedules_compose" ON "zero_agent_schedules" USING btree ("compose_id");--> statement-breakpoint
CREATE INDEX "idx_zero_agent_schedules_org" ON "zero_agent_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_agent_schedules_compose_name_org_user" ON "zero_agent_schedules" USING btree ("compose_id","name","org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_zero_agent_schedules_next_run" ON "zero_agent_schedules" USING btree ("next_run_at") WHERE enabled = true;--> statement-breakpoint
CREATE VIEW "agent_schedules" AS SELECT * FROM "zero_agent_schedules";