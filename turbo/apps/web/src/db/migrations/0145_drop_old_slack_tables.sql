-- Drop old (non-org-aware) Slack integration tables.
-- These are replaced by the slack_org_* tables (migration 0135).
-- Child tables (with foreign keys) are dropped before parent tables.

DROP TABLE IF EXISTS "slack_compose_requests";
DROP TABLE IF EXISTS "slack_pending_questions";
DROP TABLE IF EXISTS "slack_thread_sessions";
DROP TABLE IF EXISTS "slack_user_links";
DROP TABLE IF EXISTS "slack_installations";
