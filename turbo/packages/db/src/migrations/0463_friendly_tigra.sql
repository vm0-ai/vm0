ALTER TABLE "agent_run_callbacks" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_callbacks" ADD COLUMN "internal_kind" varchar(64);