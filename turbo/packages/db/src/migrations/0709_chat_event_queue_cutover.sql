-- Freeze legacy writers while the in-flight rows are classified and converted.
-- The application writer deployed with this migration no longer touches this
-- table; the lock closes any concurrent legacy write already in flight when
-- cutover starts.
LOCK TABLE "chat_message_queue" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE "chat_event_queue_rows_0709"
ON COMMIT DROP
AS
SELECT
  queue.*,
  CASE
    WHEN queue."item_type" IN (
      'user_message',
      'slack_user_message',
      'feishu_user_message',
      'teams_user_message'
    )
      AND queue."chat_message_id" IS NOT NULL
      AND queue."automation_id" IS NULL
      AND queue."trigger_brief" IS NULL
      AND (
        (queue."item_type" = 'user_message'
          AND (queue."trigger_source" IS NULL OR queue."trigger_source" = 'web'))
        OR (queue."item_type" = 'slack_user_message'
          AND queue."trigger_source" = 'slack'
          AND queue."encrypted_params" IS NOT NULL)
        OR (queue."item_type" = 'feishu_user_message'
          AND queue."trigger_source" = 'feishu'
          AND queue."encrypted_params" IS NOT NULL)
        OR (queue."item_type" = 'teams_user_message'
          AND queue."trigger_source" = 'teams'
          AND queue."encrypted_params" IS NOT NULL)
      )
      AND EXISTS (
        SELECT 1
        FROM "chat_messages" AS message
        INNER JOIN "chat_threads" AS thread
          ON thread."id" = message."chat_thread_id"
        WHERE message."id" = queue."chat_message_id"
          AND message."chat_thread_id" = queue."chat_thread_id"
          AND message."event_type" = 'input.prompt'
          AND message."run_id" IS NULL
          AND message."automation_id" IS NULL
          AND message."trigger_brief" IS NULL
          AND (message."trigger_source" IS NULL
            OR message."trigger_source" = CASE queue."item_type"
              WHEN 'slack_user_message' THEN 'slack'
              WHEN 'feishu_user_message' THEN 'feishu'
              WHEN 'teams_user_message' THEN 'teams'
              ELSE 'web'
            END)
          AND (message."encrypted_params" IS NULL
            OR message."encrypted_params" IS NOT DISTINCT FROM queue."encrypted_params")
          AND thread."user_id" = queue."user_id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_message_queue" AS duplicate
        WHERE duplicate."chat_message_id" = queue."chat_message_id"
          AND duplicate."id" <> queue."id"
      )
    THEN 'user'
    WHEN queue."item_type" = 'workflow_event'
      AND queue."chat_message_id" IS NULL
      AND queue."automation_id" IS NOT NULL
      AND queue."trigger_source" IN (
        'web',
        'slack',
        'teams',
        'feishu',
        'email',
        'telegram',
        'agentphone',
        'github',
        'cli',
        'agent',
        'webhook',
        'workflow-schedule',
        'workflow-event'
      )
      AND queue."encrypted_params" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "zero_workflow_automations" AS automation
        INNER JOIN "workflow_user_automation_threads" AS binding
          ON binding."workflow_id" = automation."workflow_id"
          AND binding."org_id" = automation."org_id"
          AND binding."user_id" = automation."owner_user_id"
        WHERE automation."id" = queue."automation_id"
          AND automation."org_id" = queue."org_id"
          AND automation."owner_user_id" = queue."user_id"
          AND binding."chat_thread_id" = queue."chat_thread_id"
      )
    THEN 'automation'
  END AS "classification"
FROM "chat_message_queue" AS queue;
--> statement-breakpoint
DO $$
DECLARE
  unclassified_count bigint;
  unclassified_sample text;
BEGIN
  SELECT COUNT(*), MIN("id"::text)
  INTO unclassified_count, unclassified_sample
  FROM "chat_event_queue_rows_0709"
  WHERE "classification" IS NULL;

  IF unclassified_count > 0 THEN
    RAISE EXCEPTION
      'chat event queue cutover failed: % unclassifiable rows (sample %)',
      unclassified_count,
      unclassified_sample;
  END IF;
END $$;
--> statement-breakpoint
-- ChatEvent inserts reserve seq ids by locking chat_threads. Use the same lock
-- in stable id order so appends cannot race the migration's reservation.
SELECT "id"
FROM "chat_threads"
WHERE "id" IN (
  SELECT "chat_thread_id" FROM "chat_event_queue_rows_0709"
  UNION
  SELECT "id" FROM "chat_threads" WHERE "queue_paused_at" IS NOT NULL
)
ORDER BY "id"
FOR UPDATE;
--> statement-breakpoint
-- Keep append-only protection installed while narrowly allowing only the two
-- typed queue payload columns to transition from NULL to their classified
-- values on legacy pending input.prompt rows.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME <> 'chat_messages' THEN
    RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
  END IF;

  IF OLD."event_type" = 'input.prompt'
    AND NEW."event_type" = OLD."event_type"
    AND NEW."trigger_source" IS NOT NULL
    AND (OLD."trigger_source" IS NULL
      OR NEW."trigger_source" = OLD."trigger_source")
    AND (OLD."encrypted_params" IS NULL
      OR NEW."encrypted_params" = OLD."encrypted_params")
    AND (NEW."trigger_source" IS DISTINCT FROM OLD."trigger_source"
      OR NEW."encrypted_params" IS DISTINCT FROM OLD."encrypted_params")
    AND (to_jsonb(NEW) - 'trigger_source' - 'encrypted_params')
      = (to_jsonb(OLD) - 'trigger_source' - 'encrypted_params')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
UPDATE "chat_messages" AS message
SET
  "trigger_source" = COALESCE(
    message."trigger_source",
    CASE queue."item_type"
      WHEN 'slack_user_message' THEN 'slack'
      WHEN 'feishu_user_message' THEN 'feishu'
      WHEN 'teams_user_message' THEN 'teams'
      ELSE 'web'
    END
  ),
  "encrypted_params" = COALESCE(
    message."encrypted_params",
    queue."encrypted_params"
  )
FROM "chat_event_queue_rows_0709" AS queue
WHERE queue."classification" = 'user'
  AND message."id" = queue."chat_message_id"
  AND (
    message."trigger_source" IS DISTINCT FROM COALESCE(
      message."trigger_source",
      CASE queue."item_type"
        WHEN 'slack_user_message' THEN 'slack'
        WHEN 'feishu_user_message' THEN 'feishu'
        WHEN 'teams_user_message' THEN 'teams'
        ELSE 'web'
      END
    )
    OR message."encrypted_params" IS DISTINCT FROM COALESCE(
      message."encrypted_params",
      queue."encrypted_params"
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TEMP TABLE "chat_event_queue_appends_0709" (
  "id" uuid PRIMARY KEY,
  "chat_thread_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "role" text NOT NULL,
  "automation_id" uuid,
  "trigger_source" text,
  "trigger_brief" text,
  "encrypted_params" text,
  "error" text,
  "created_at" timestamp NOT NULL
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO "chat_event_queue_appends_0709" (
  "id",
  "chat_thread_id",
  "event_type",
  "role",
  "automation_id",
  "trigger_source",
  "trigger_brief",
  "encrypted_params",
  "created_at"
)
SELECT
  queue."id",
  queue."chat_thread_id",
  'input.automation',
  'user',
  queue."automation_id",
  queue."trigger_source",
  queue."trigger_brief",
  queue."encrypted_params",
  queue."created_at"
FROM "chat_event_queue_rows_0709" AS queue
WHERE queue."classification" = 'automation';
--> statement-breakpoint
INSERT INTO "chat_event_queue_appends_0709" (
  "id",
  "chat_thread_id",
  "event_type",
  "role",
  "error",
  "created_at"
)
SELECT
  gen_random_uuid(),
  thread."id",
  'queue.automation_paused',
  'assistant',
  thread."pause_reason",
  thread."queue_paused_at"
FROM "chat_threads" AS thread
WHERE thread."queue_paused_at" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "chat_messages" AS transition
    WHERE transition."chat_thread_id" = thread."id"
      AND transition."event_type" IN (
        'queue.automation_paused',
        'queue.automation_resumed'
      )
  );
--> statement-breakpoint
DO $$
DECLARE
  collision_count bigint;
  collision_sample text;
BEGIN
  SELECT COUNT(*), MIN(planned."id"::text)
  INTO collision_count, collision_sample
  FROM "chat_event_queue_appends_0709" AS planned
  INNER JOIN "chat_messages" AS existing ON existing."id" = planned."id";

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      'chat event queue cutover failed: % event id collisions (sample %)',
      collision_count,
      collision_sample;
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE "chat_event_queue_offsets_0709"
ON COMMIT DROP
AS
SELECT
  thread."id" AS "chat_thread_id",
  thread."last_chat_message_seq_id" AS "base_seq_id",
  COUNT(*)::bigint AS "event_count"
FROM "chat_threads" AS thread
INNER JOIN "chat_event_queue_appends_0709" AS planned
  ON planned."chat_thread_id" = thread."id"
GROUP BY thread."id", thread."last_chat_message_seq_id";
--> statement-breakpoint
UPDATE "chat_threads" AS thread
SET "last_chat_message_seq_id" =
  thread."last_chat_message_seq_id" + offsets."event_count"
FROM "chat_event_queue_offsets_0709" AS offsets
WHERE thread."id" = offsets."chat_thread_id";
--> statement-breakpoint
INSERT INTO "chat_messages" (
  "id",
  "chat_thread_id",
  "run_id",
  "event_type",
  "automation_id",
  "trigger_source",
  "trigger_brief",
  "encrypted_params",
  "role",
  "content",
  "error",
  "seq_id",
  "created_at"
)
SELECT
  planned."id",
  planned."chat_thread_id",
  NULL,
  planned."event_type",
  planned."automation_id",
  planned."trigger_source",
  planned."trigger_brief",
  planned."encrypted_params",
  planned."role",
  NULL,
  planned."error",
  offsets."base_seq_id" + ROW_NUMBER() OVER (
    PARTITION BY planned."chat_thread_id"
    ORDER BY planned."created_at", planned."id"
  ),
  planned."created_at"
FROM "chat_event_queue_appends_0709" AS planned
INNER JOIN "chat_event_queue_offsets_0709" AS offsets
  ON offsets."chat_thread_id" = planned."chat_thread_id";
--> statement-breakpoint
DELETE FROM "chat_message_queue";
