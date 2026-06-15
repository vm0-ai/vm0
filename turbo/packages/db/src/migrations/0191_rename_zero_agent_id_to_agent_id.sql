ALTER TABLE "zero_agent_schedules" RENAME COLUMN "zero_agent_id" TO "agent_id";--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" RENAME CONSTRAINT "zero_agent_schedules_zero_agent_id_zero_agents_id_fk" TO "zero_agent_schedules_agent_id_zero_agents_id_fk";
