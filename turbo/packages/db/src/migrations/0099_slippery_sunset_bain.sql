ALTER TABLE "compose_jobs" ALTER COLUMN "github_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "compose_jobs" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "compose_jobs" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "compose_jobs" ADD COLUMN "source" varchar(20) DEFAULT 'github' NOT NULL;