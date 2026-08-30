CREATE VIEW "workflows" AS
SELECT
  "id",
  "org_id",
  "agent_id",
  "name",
  "visibility",
  "instruction",
  "owner_user_id",
  "display_name",
  "description",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at"
FROM "zero_workflows";
--> statement-breakpoint
CREATE VIEW "workflow_automations" AS
SELECT
  "id",
  "org_id",
  "workflow_id",
  "owner_user_id",
  "kind",
  "event_type",
  "event_config",
  "schedule_type",
  "cron_expression",
  "interval_seconds",
  "at_time",
  "timezone",
  "enabled",
  "next_run_at",
  "last_run_at",
  "last_run_id",
  "consecutive_failures",
  "autonomy_budget",
  "created_at",
  "updated_at"
FROM "zero_workflow_automations";
--> statement-breakpoint
CREATE VIEW "workflow_webhook_automations" AS
SELECT
  "automation_id",
  "token_hash",
  "encrypted_token",
  "encrypted_secret",
  "secret_last_four",
  "disabled_reason",
  "last_received_at",
  "created_at",
  "updated_at"
FROM "zero_workflow_webhook_automations";
--> statement-breakpoint
CREATE VIEW "workflow_webhook_deliveries" AS
SELECT
  "id",
  "automation_id",
  "delivery_key",
  "body_sha256",
  "status",
  "run_id",
  "error_message",
  "received_at",
  "created_at"
FROM "zero_workflow_webhook_deliveries";
--> statement-breakpoint
CREATE VIEW "workflow_github_processed_events" AS
SELECT
  "id",
  "automation_id",
  "github_delivery_id",
  "repo",
  "subject_type",
  "subject_number",
  "action",
  "label_name_normalized",
  "created_at"
FROM "zero_workflow_github_processed_events";
--> statement-breakpoint
CREATE VIEW "workflow_strapi_automations" AS
SELECT
  "automation_id",
  "integration_id",
  "created_at"
FROM "zero_workflow_strapi_automations";
