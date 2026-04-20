DROP VIEW IF EXISTS "agent_schedules";--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "zero_agent_schedules_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP COLUMN "compose_id";