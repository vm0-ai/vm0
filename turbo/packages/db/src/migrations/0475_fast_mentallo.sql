UPDATE "zero_workflow_triggers" AS "trigger"
SET "enabled" = false,
    "chat_thread_id" = NULL,
    "next_run_at" = NULL,
    "updated_at" = NOW()
FROM "zero_workflows" AS "workflow"
WHERE "trigger"."workflow_id" = "workflow"."id"
  AND "workflow"."type" = 'goal'
  AND "workflow"."active" = false
  AND "trigger"."kind" = 'event'
  AND "trigger"."event_type" = 'thread-idle'
  AND "trigger"."chat_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_triggers_thread_idle_thread_unique" ON "zero_workflow_triggers" USING btree ("org_id","chat_thread_id") WHERE chat_thread_id IS NOT NULL AND kind = 'event' AND event_type = 'thread-idle';
