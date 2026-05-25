ALTER TABLE "agent_sessions" ADD COLUMN "artifact_names" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "agent_sessions"
SET "artifact_names" = CASE
  WHEN "artifact_name" IS NOT NULL THEN jsonb_build_array("artifact_name")
  ELSE '[]'::jsonb
END;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_agent_sessions_user_compose_artifact";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "artifact_name";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "memory_name";--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_user_compose" ON "agent_sessions" USING btree ("user_id","agent_compose_id");
