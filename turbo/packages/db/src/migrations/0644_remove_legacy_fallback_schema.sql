ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_generation" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_generation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_sequence" SET NOT NULL;