-- Migration: Align existing schema with Drizzle-generated expectations
-- This migration ensures the database schema matches what Drizzle generates,
-- enabling consistent migration generation going forward.

-- =============================================================================
-- Part 1: Rename legacy constraint names to match Drizzle conventions
-- =============================================================================

-- Rename primary key constraints from old table names
ALTER INDEX IF EXISTS agent_configs_pkey RENAME TO agent_composes_pkey;
ALTER INDEX IF EXISTS agent_runtimes_pkey RENAME TO agent_runs_pkey;
ALTER INDEX IF EXISTS agent_runtime_events_pkey RENAME TO agent_run_events_pkey;
ALTER INDEX IF EXISTS credentials_pkey RENAME TO secrets_pkey;
ALTER INDEX IF EXISTS volumes_pkey RENAME TO storages_pkey;

-- Rename unique constraint indexes
ALTER INDEX IF EXISTS scopes_slug_key RENAME TO scopes_slug_unique;
ALTER INDEX IF EXISTS slack_installations_slack_workspace_id_key RENAME TO slack_installations_slack_workspace_id_unique;

-- Rename foreign key index
ALTER INDEX IF EXISTS idx_model_providers_credential RENAME TO idx_model_providers_secret;

-- =============================================================================
-- Part 2: Rebuild indexes to add NULLS LAST and improve definitions
-- =============================================================================

-- 2.1: Improve idx_agent_permissions_email
-- Old: Only grantee_email with WHERE clause
-- New: Add created_at for time-based queries, both DESC with NULLS LAST
DROP INDEX IF EXISTS idx_agent_permissions_email;
CREATE INDEX idx_agent_permissions_email
  ON agent_permissions (grantee_email DESC NULLS LAST, created_at DESC NULLS LAST)
  WHERE grantee_email IS NOT NULL;

-- 2.2: Add NULLS LAST to idx_agent_runs_user_created
DROP INDEX IF EXISTS idx_agent_runs_user_created;
CREATE INDEX idx_agent_runs_user_created
  ON agent_runs (user_id, created_at DESC NULLS LAST);

-- 2.3: Add NULLS LAST to idx_agent_runs_schedule_created
DROP INDEX IF EXISTS idx_agent_runs_schedule_created;
CREATE INDEX idx_agent_runs_schedule_created
  ON agent_runs (schedule_id, created_at DESC NULLS LAST)
  WHERE schedule_id IS NOT NULL;

-- 2.4: Add NULLS LAST to idx_images_latest_lookup
DROP INDEX IF EXISTS idx_images_latest_lookup;
CREATE INDEX idx_images_latest_lookup
  ON images (scope_id, alias, status, created_at DESC NULLS LAST);

-- =============================================================================
-- Part 3: Rename foreign key constraints to match Drizzle naming conventions
-- =============================================================================

-- Drizzle uses format: {source_table}_{source_column}_{target_table}_{target_column}_fk
-- Old format was: {source_table}_{source_column}_fkey

-- Agent compose related
ALTER TABLE agent_compose_versions RENAME CONSTRAINT agent_compose_versions_compose_id_fkey TO agent_compose_versions_compose_id_agent_composes_id_fk;
ALTER TABLE agent_composes RENAME CONSTRAINT agent_composes_scope_id_fkey TO agent_composes_scope_id_scopes_id_fk;
ALTER TABLE agent_permissions RENAME CONSTRAINT agent_permissions_agent_compose_id_fkey TO agent_permissions_agent_compose_id_agent_composes_id_fk;
ALTER TABLE agent_run_callbacks RENAME CONSTRAINT agent_run_callbacks_run_id_fkey TO agent_run_callbacks_run_id_agent_runs_id_fk;
ALTER TABLE agent_run_events_local RENAME CONSTRAINT agent_run_events_local_run_id_fkey TO agent_run_events_local_run_id_agent_runs_id_fk;
ALTER TABLE agent_runs RENAME CONSTRAINT agent_runs_agent_compose_version_id_fkey TO agent_runs_agent_compose_version_id_agent_compose_versions_id_f;
ALTER TABLE agent_schedules RENAME CONSTRAINT agent_schedules_compose_id_fkey TO agent_schedules_compose_id_agent_composes_id_fk;
ALTER TABLE agent_schedules RENAME CONSTRAINT agent_schedules_last_run_id_fkey TO agent_schedules_last_run_id_agent_runs_id_fk;
ALTER TABLE agent_sessions RENAME CONSTRAINT agent_sessions_agent_config_id_agent_configs_id_fk TO agent_sessions_agent_compose_id_agent_composes_id_fk;

-- Scope related
ALTER TABLE connectors RENAME CONSTRAINT connectors_scope_id_fkey TO connectors_scope_id_scopes_id_fk;
ALTER TABLE images RENAME CONSTRAINT images_scope_id_fkey TO images_scope_id_scopes_id_fk;
ALTER TABLE secrets RENAME CONSTRAINT credentials_scope_id_fkey TO secrets_scope_id_scopes_id_fk;
ALTER TABLE storages RENAME CONSTRAINT storages_scope_id_fkey TO storages_scope_id_scopes_id_fk;
ALTER TABLE users RENAME CONSTRAINT users_scope_id_fkey TO users_scope_id_scopes_id_fk;
ALTER TABLE variables RENAME CONSTRAINT variables_scope_id_fkey TO variables_scope_id_scopes_id_fk;

-- Model providers
ALTER TABLE model_providers RENAME CONSTRAINT model_providers_scope_id_fkey TO model_providers_scope_id_scopes_id_fk;
ALTER TABLE model_providers RENAME CONSTRAINT model_providers_credential_id_fkey TO model_providers_secret_id_secrets_id_fk;

-- Runner
ALTER TABLE runner_job_queue RENAME CONSTRAINT runner_job_queue_run_id_fkey TO runner_job_queue_run_id_agent_runs_id_fk;

-- =============================================================================
-- Verification Notes
-- =============================================================================
-- After running this migration:
-- 1. All primary key names match Drizzle conventions
-- 2. All indexes use DESC NULLS LAST for proper null handling
-- 3. Performance-critical indexes are optimized (e.g., agent_permissions email lookup)
-- 4. Future drizzle-kit generate commands should produce minimal/no changes
