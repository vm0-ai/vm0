ALTER TABLE "runner_state" ADD COLUMN "held_session_states" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_state" DROP COLUMN "held_sessions";
