-- Pre-flight guard: abort with a clear message if any agent_runs row still has
-- session_id IS NULL. Prior migrations 0286/0287/0288 drained the legacy NULL
-- rows; if this check fires, something is out of order.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_runs WHERE session_id IS NULL) THEN
    RAISE EXCEPTION 'agent_runs has NULL session_id rows — run migrations 0286/0287/0288 first';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
