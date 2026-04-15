CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"run_id" uuid,
	"role" text NOT NULL,
	"content" text,
	"error" text,
	"sequence_number" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread_created" ON "chat_messages" USING btree ("chat_thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_run_id" ON "chat_messages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_run_seq_unique" ON "chat_messages" USING btree ("run_id","sequence_number");--> statement-breakpoint
-- Migrate existing JSONB messages from zero_agent_sessions into chat_messages rows.
--
-- Resolution strategies (in priority order):
--   1. Direct runId → chat_thread_runs lookup (assistant messages with known run)
--   2. Next message's runId → chat_thread_runs (user messages paired with assistant)
--   3. Any assistant in same session → chat_thread_runs (trailing user messages / failed runs)
--   4. Fallback: session → chat_threads.session_id
--
-- Deduplication: the same message may appear in multiple sessions (multi-turn chat appends
-- earlier messages into newer sessions). We deduplicate by picking the first resolution
-- per (run_id, role, content, created_at_str) tuple using ROW_NUMBER().
--
-- Timestamp fix: assistant messages get +1ms to guarantee they sort after their paired user.

WITH numbered_msgs AS (
  SELECT
    zas.id AS session_id,
    ordinality AS pos,
    msg->>'role' AS role,
    msg->>'content' AS content,
    NULLIF(msg->>'runId', '') AS run_id_str,
    msg->>'createdAt' AS created_at_str
  FROM zero_agent_sessions zas
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(zas.chat_messages, '[]'::jsonb))
    WITH ORDINALITY AS t(msg, ordinality)
  WHERE zas.chat_messages IS NOT NULL
    AND jsonb_array_length(zas.chat_messages) > 0
),
resolved AS (
  SELECT
    nm.*,
    COALESCE(
      -- Strategy 1: runId → chat_thread_runs (assistant messages with known run)
      (SELECT ctr.chat_thread_id FROM chat_thread_runs ctr
       WHERE nm.run_id_str IS NOT NULL AND ctr.run_id = nm.run_id_str::uuid
       LIMIT 1),
      -- Strategy 2: next message's runId → chat_thread_runs (user paired with assistant)
      (SELECT ctr.chat_thread_id FROM numbered_msgs nm2
       JOIN chat_thread_runs ctr ON ctr.run_id = nm2.run_id_str::uuid
       WHERE nm2.session_id = nm.session_id AND nm2.pos = nm.pos + 1
         AND nm2.run_id_str IS NOT NULL
       LIMIT 1),
      -- Strategy 3: any run in same session → chat_thread_runs (for failed runs / trailing user messages)
      (SELECT ctr.chat_thread_id FROM numbered_msgs nm3
       JOIN chat_thread_runs ctr ON ctr.run_id = nm3.run_id_str::uuid
       WHERE nm3.session_id = nm.session_id AND nm3.run_id_str IS NOT NULL
       LIMIT 1),
      -- Strategy 4: session_id on chat_thread (final fallback)
      (SELECT ct.id FROM chat_threads ct WHERE ct.session_id = nm.session_id
       LIMIT 1)
    ) AS chat_thread_id
  FROM numbered_msgs nm
),
-- Deduplicate: same (thread, run_id, role, content, timestamp) can appear from multiple sessions.
-- Keep only one copy, preferring the row from the session pointed to by session_id.
deduped AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.chat_thread_id, r.run_id_str, r.role, r.content, r.created_at_str
      ORDER BY
        -- Prefer the session that the thread's session_id points to
        CASE WHEN EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.session_id = r.session_id AND ct.id = r.chat_thread_id) THEN 0 ELSE 1 END,
        r.session_id
    ) AS rn
  FROM resolved r
  WHERE r.chat_thread_id IS NOT NULL
)
INSERT INTO "chat_messages" ("chat_thread_id", "run_id", "role", "content", "created_at")
SELECT
  chat_thread_id,
  CASE WHEN run_id_str IS NOT NULL THEN run_id_str::uuid ELSE NULL END,
  role,
  content,
  CASE
    WHEN created_at_str IS NOT NULL THEN
      (created_at_str::timestamp) +
      CASE WHEN role = 'assistant' THEN interval '1 millisecond' ELSE interval '0' END
    ELSE
      now() +
      CASE WHEN role = 'assistant' THEN interval '1 millisecond' ELSE interval '0' END
  END
FROM deduped
WHERE rn = 1;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat_thread_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "session_id";
