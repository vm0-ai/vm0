DROP TRIGGER IF EXISTS "classify_legacy_slack_cutover_ingress" ON "slack_chat_ingress";--> statement-breakpoint
DROP FUNCTION IF EXISTS "classify_legacy_slack_cutover_ingress"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "canonicalize_slack_chat_thread_route" ON "slack_chat_thread_routes";--> statement-breakpoint
DROP FUNCTION IF EXISTS "canonicalize_slack_chat_thread_route"();--> statement-breakpoint
DELETE FROM "slack_chat_ingress"
WHERE "status" = 'ignored';--> statement-breakpoint
DELETE FROM "slack_chat_thread_routes"
WHERE "backend" = 'legacy'
   OR "chat_thread_id" IS NULL;--> statement-breakpoint
UPDATE "user_feature_switches"
SET
  "switches" = "switches"
    - 'canonicalSlackIngress'
    - 'canonicalSlackWebVisibility'
    - 'canonicalSlackAssets',
  "updated_at" = NOW()
WHERE "switches" ?| ARRAY[
  'canonicalSlackIngress',
  'canonicalSlackWebVisibility',
  'canonicalSlackAssets'
];
