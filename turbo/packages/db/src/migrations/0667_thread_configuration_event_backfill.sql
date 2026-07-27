-- Custom SQL migration file, put your code below! --
INSERT INTO "chat_thread_events" (
  "user_id",
  "org_id",
  "chat_thread_id",
  "kind",
  "agent_compose_id",
  "service_tier",
  "created_at"
)
SELECT
  thread."user_id",
  compose."org_id",
  thread."id",
  'service_tier_updated',
  thread."agent_compose_id",
  'priority',
  NOW()
FROM "chat_threads" thread
INNER JOIN "agent_composes" compose
  ON compose."id" = thread."agent_compose_id"
WHERE thread."codex_service_tier" = 'fast';
--> statement-breakpoint
INSERT INTO "chat_thread_events" (
  "user_id",
  "org_id",
  "chat_thread_id",
  "kind",
  "agent_compose_id",
  "computer_use_host_id",
  "created_at"
)
SELECT
  thread."user_id",
  compose."org_id",
  thread."id",
  'computer_use_host_updated',
  thread."agent_compose_id",
  thread."computer_use_host_id",
  NOW()
FROM "chat_threads" thread
INNER JOIN "agent_composes" compose
  ON compose."id" = thread."agent_compose_id"
WHERE thread."computer_use_host_id" IS NOT NULL;
