ALTER TABLE "chat_messages" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_type_check" CHECK ("chat_messages"."event_type" IS NULL OR "chat_messages"."event_type" IN (
          'input.prompt',
          'input.rejected',
          'output.message',
          'output.error',
          'output.thinking',
          'output.followups',
          'run.queued',
          'run.dequeued',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'control.interrupt',
          'control.revoke',
          'goal.changed',
          'usage.recorded'
        ));
--> statement-breakpoint
DROP TRIGGER "chat_messages_reject_update" ON "chat_messages";
--> statement-breakpoint
DO $$
DECLARE
  unmatched_count bigint;
  ambiguous_count bigint;
  unmatched_sample text;
  ambiguous_sample text;
BEGIN
  CREATE TEMP TABLE "chat_event_classification_0666"
  ON COMMIT DROP
  AS
  SELECT
    "id",
    array_remove(ARRAY[
      CASE
        WHEN "role" = 'user'
          AND "error" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND NOT (
            "revokes_message_id" IS NOT NULL
            AND "content" IS NULL
            AND "structured_prompt" IS NULL
            AND "attach_files" IS NULL
            AND "attach_file_metadata" IS NULL
            AND "generation_template" IS NULL
          )
        THEN 'input.prompt'
      END,
      CASE
        WHEN "role" = 'user'
          AND "error" IS NOT NULL
          AND "interrupts_run_id" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
        THEN 'input.rejected'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "content" IS NOT NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
          AND "run_event_id" IS DISTINCT FROM 'queue:queued'
          AND "run_event_id" IS DISTINCT FROM 'queue:dequeued'
        THEN 'output.message'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "error" IS NOT NULL
          AND "run_lifecycle_event" IS NULL
          AND "thinking" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
          AND "run_event_id" IS DISTINCT FROM 'queue:queued'
          AND "run_event_id" IS DISTINCT FROM 'queue:dequeued'
        THEN 'output.error'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "thinking" IS NOT NULL
          AND "content" IS NULL
          AND "error" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'output.thinking'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "recommended_followups" IS NOT NULL
          AND "content" IS NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'output.followups'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "run_event_id" = 'queue:queued'
          AND "run_id" IS NOT NULL
          AND "content" IS NOT NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'run.queued'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "run_event_id" = 'queue:dequeued'
          AND "run_id" IS NOT NULL
          AND "revokes_message_id" IS NOT NULL
          AND "content" IS NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'run.dequeued'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "run_lifecycle_event" = 'completed'
          AND "run_id" IS NOT NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'run.completed'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "run_lifecycle_event" = 'failed'
          AND "run_id" IS NOT NULL
          AND "thinking" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'run.failed'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "run_lifecycle_event" = 'cancelled'
          AND "run_id" IS NOT NULL
          AND "thinking" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'run.cancelled'
      END,
      CASE
        WHEN "role" = 'user'
          AND "interrupts_run_id" IS NOT NULL
          AND "content" IS NULL
          AND "run_id" IS NULL
          AND "run_event_id" IS NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'control.interrupt'
      END,
      CASE
        WHEN "role" = 'user'
          AND "revokes_message_id" IS NOT NULL
          AND "content" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
          AND "error" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "run_id" IS NULL
          AND "run_event_id" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
        THEN 'control.revoke'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "goal_event" IS NOT NULL
          AND "content" IS NULL
          AND "run_id" IS NULL
          AND "run_event_id" IS NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "usage_payload" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'goal.changed'
      END,
      CASE
        WHEN "role" = 'assistant'
          AND "usage_payload" IS NOT NULL
          AND "run_id" IS NOT NULL
          AND "content" IS NULL
          AND "run_event_id" IS NULL
          AND "error" IS NULL
          AND "thinking" IS NULL
          AND "run_lifecycle_event" IS NULL
          AND "goal_event" IS NULL
          AND "recommended_followups" IS NULL
          AND "revokes_message_id" IS NULL
          AND "interrupts_run_id" IS NULL
          AND "structured_prompt" IS NULL
          AND "attach_files" IS NULL
          AND "attach_file_metadata" IS NULL
          AND "generation_template" IS NULL
        THEN 'usage.recorded'
      END
    ], NULL) AS matches
  FROM "chat_messages";

  SELECT
    COUNT(*) FILTER (WHERE cardinality(matches) = 0),
    COUNT(*) FILTER (WHERE cardinality(matches) > 1),
    MIN("id"::text) FILTER (WHERE cardinality(matches) = 0),
    MIN("id"::text) FILTER (WHERE cardinality(matches) > 1)
  INTO
    unmatched_count,
    ambiguous_count,
    unmatched_sample,
    ambiguous_sample
  FROM "chat_event_classification_0666";

  IF unmatched_count > 0 OR ambiguous_count > 0 THEN
    RAISE EXCEPTION
      'chat event classification failed: % unmatched (sample %), % ambiguous (sample %)',
      unmatched_count,
      unmatched_sample,
      ambiguous_count,
      ambiguous_sample;
  END IF;

  UPDATE "chat_messages" AS message
  SET "event_type" = classified.matches[1]
  FROM "chat_event_classification_0666" AS classified
  WHERE message."id" = classified."id";
END $$;
--> statement-breakpoint
CREATE TRIGGER "chat_messages_reject_update"
BEFORE UPDATE ON "chat_messages"
FOR EACH ROW EXECUTE FUNCTION "reject_chat_event_source_update"();
