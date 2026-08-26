ALTER TABLE "agent_runs" ADD COLUMN "runner_hostname" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runner_version" varchar(128);