ALTER TABLE "agent_schedules" DROP CONSTRAINT "trigger_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_agent_compose_version_id_agent_compose_versions_id_f";
--> statement-breakpoint
ALTER TABLE "email_reply_requests" DROP CONSTRAINT "email_reply_requests_email_thread_session_id_email_thread_sessi";
--> statement-breakpoint
DROP INDEX "idx_users_scope";--> statement-breakpoint
DROP INDEX "idx_agent_composes_scope";--> statement-breakpoint
DROP INDEX "idx_agent_composes_scope_name";--> statement-breakpoint
DROP INDEX "idx_agent_runs_running_heartbeat";--> statement-breakpoint
DROP INDEX "idx_agent_runs_schedule_created";--> statement-breakpoint
DROP INDEX "idx_agent_runs_status_heartbeat";--> statement-breakpoint
DROP INDEX "idx_agent_runs_user_created";--> statement-breakpoint
DROP INDEX "idx_storages_scope";--> statement-breakpoint
DROP INDEX "idx_storages_scope_name_type";--> statement-breakpoint
DROP INDEX "idx_agent_sessions_user_compose_artifact";--> statement-breakpoint
DROP INDEX "idx_blobs_ref_count";--> statement-breakpoint
DROP INDEX "idx_agent_compose_versions_compose_id";--> statement-breakpoint
DROP INDEX "idx_images_latest_lookup";--> statement-breakpoint
DROP INDEX "idx_images_scope";--> statement-breakpoint
DROP INDEX "idx_images_scope_alias_legacy";--> statement-breakpoint
DROP INDEX "idx_images_scope_alias_version";--> statement-breakpoint
DROP INDEX "idx_sandbox_telemetry_run_id";--> statement-breakpoint
DROP INDEX "idx_scopes_owner";--> statement-breakpoint
DROP INDEX "idx_scopes_type";--> statement-breakpoint
DROP INDEX "runner_job_queue_expires_at_idx";--> statement-breakpoint
DROP INDEX "runner_job_queue_group_unclaimed_idx";--> statement-breakpoint
DROP INDEX "idx_secrets_scope";--> statement-breakpoint
DROP INDEX "idx_secrets_scope_name_type";--> statement-breakpoint
DROP INDEX "idx_secrets_type";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose_name";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_next_run";--> statement-breakpoint
DROP INDEX "idx_model_providers_scope";--> statement-breakpoint
DROP INDEX "idx_model_providers_scope_type";--> statement-breakpoint
DROP INDEX "idx_model_providers_secret";--> statement-breakpoint
DROP INDEX "idx_variables_scope";--> statement-breakpoint
DROP INDEX "idx_variables_scope_name";--> statement-breakpoint
DROP INDEX "idx_agent_permissions_compose";--> statement-breakpoint
DROP INDEX "idx_agent_permissions_email";--> statement-breakpoint
DROP INDEX "idx_connectors_scope";--> statement-breakpoint
DROP INDEX "idx_connectors_scope_type";--> statement-breakpoint
DROP INDEX "idx_slack_user_links_user_workspace";--> statement-breakpoint
DROP INDEX "idx_compose_jobs_created";--> statement-breakpoint
DROP INDEX "idx_compose_jobs_user_status";--> statement-breakpoint
DROP INDEX "idx_connector_sessions_code";--> statement-breakpoint
DROP INDEX "idx_connector_sessions_user_status";--> statement-breakpoint
DROP INDEX "uq_usage_daily_user_date";--> statement-breakpoint
DROP INDEX "idx_slack_compose_requests_job";--> statement-breakpoint
DROP INDEX "idx_slack_thread_sessions_thread_user_link";--> statement-breakpoint
DROP INDEX "idx_slack_thread_sessions_user_link";--> statement-breakpoint
DROP INDEX "idx_agent_run_events_local_run_id";--> statement-breakpoint
DROP INDEX "idx_agent_run_events_local_run_seq";--> statement-breakpoint
DROP INDEX "idx_agent_run_callbacks_pending";--> statement-breakpoint
DROP INDEX "idx_agent_run_callbacks_run_id";--> statement-breakpoint
DROP INDEX "idx_email_thread_sessions_reply_token";--> statement-breakpoint
DROP INDEX "idx_email_thread_sessions_user";--> statement-breakpoint
DROP INDEX "idx_email_reply_requests_run";--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "platform" varchar(50) DEFAULT 'self-hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "nango_connection_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_compose_version_id_agent_compose_versions_id_fk" FOREIGN KEY ("agent_compose_version_id") REFERENCES "public"."agent_compose_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_reply_requests" ADD CONSTRAINT "email_reply_requests_email_thread_session_id_email_thread_sessions_id_fk" FOREIGN KEY ("email_thread_session_id") REFERENCES "public"."email_thread_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connectors_platform" ON "connectors" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "idx_users_scope" ON "users" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "idx_agent_composes_scope" ON "agent_composes" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_composes_scope_name" ON "agent_composes" USING btree ("scope_id","name");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_running_heartbeat" ON "agent_runs" USING btree ("last_heartbeat_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idx_agent_runs_schedule_created" ON "agent_runs" USING btree ("schedule_id","created_at" DESC NULLS LAST) WHERE schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_status_heartbeat" ON "agent_runs" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_user_created" ON "agent_runs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_storages_scope" ON "storages" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storages_scope_name_type" ON "storages" USING btree ("scope_id","name","type");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_user_compose_artifact" ON "agent_sessions" USING btree ("user_id","agent_compose_id","artifact_name");--> statement-breakpoint
CREATE INDEX "idx_blobs_ref_count" ON "blobs" USING btree ("ref_count");--> statement-breakpoint
CREATE INDEX "idx_agent_compose_versions_compose_id" ON "agent_compose_versions" USING btree ("compose_id");--> statement-breakpoint
CREATE INDEX "idx_images_latest_lookup" ON "images" USING btree ("scope_id","alias","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_images_scope" ON "images" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_images_scope_alias_legacy" ON "images" USING btree ("scope_id","alias") WHERE version_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_images_scope_alias_version" ON "images" USING btree ("scope_id","alias","version_id") WHERE version_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sandbox_telemetry_run_id" ON "sandbox_telemetry" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_scopes_owner" ON "scopes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_scopes_type" ON "scopes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "runner_job_queue_expires_at_idx" ON "runner_job_queue" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "runner_job_queue_group_unclaimed_idx" ON "runner_job_queue" USING btree ("runner_group") WHERE claimed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_secrets_scope" ON "secrets" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_scope_name_type" ON "secrets" USING btree ("scope_id","name","type");--> statement-breakpoint
CREATE INDEX "idx_secrets_type" ON "secrets" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_compose" ON "agent_schedules" USING btree ("compose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_schedules_compose_name" ON "agent_schedules" USING btree ("compose_id","name");--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_next_run" ON "agent_schedules" USING btree ("next_run_at") WHERE enabled = true;--> statement-breakpoint
CREATE INDEX "idx_model_providers_scope" ON "model_providers" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_providers_scope_type" ON "model_providers" USING btree ("scope_id","type");--> statement-breakpoint
CREATE INDEX "idx_model_providers_secret" ON "model_providers" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "idx_variables_scope" ON "variables" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_variables_scope_name" ON "variables" USING btree ("scope_id","name");--> statement-breakpoint
CREATE INDEX "idx_agent_permissions_compose" ON "agent_permissions" USING btree ("agent_compose_id");--> statement-breakpoint
CREATE INDEX "idx_agent_permissions_email" ON "agent_permissions" USING btree ("grantee_email" DESC NULLS LAST,"created_at" DESC NULLS LAST) WHERE grantee_email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_connectors_scope" ON "connectors" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_scope_type" ON "connectors" USING btree ("scope_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_user_links_user_workspace" ON "slack_user_links" USING btree ("slack_user_id","slack_workspace_id");--> statement-breakpoint
CREATE INDEX "idx_compose_jobs_created" ON "compose_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_compose_jobs_user_status" ON "compose_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_sessions_code" ON "connector_sessions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_connector_sessions_user_status" ON "connector_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_daily_user_date" ON "usage_daily" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_compose_requests_job" ON "slack_compose_requests" USING btree ("compose_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_thread_sessions_thread_user_link" ON "slack_thread_sessions" USING btree ("slack_user_link_id","slack_channel_id","slack_thread_ts");--> statement-breakpoint
CREATE INDEX "idx_slack_thread_sessions_user_link" ON "slack_thread_sessions" USING btree ("slack_user_link_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_events_local_run_id" ON "agent_run_events_local" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_events_local_run_seq" ON "agent_run_events_local" USING btree ("run_id","sequence_number");--> statement-breakpoint
CREATE INDEX "idx_agent_run_callbacks_pending" ON "agent_run_callbacks" USING btree ("status") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_agent_run_callbacks_run_id" ON "agent_run_callbacks" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_thread_sessions_reply_token" ON "email_thread_sessions" USING btree ("reply_to_token");--> statement-breakpoint
CREATE INDEX "idx_email_thread_sessions_user" ON "email_thread_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_reply_requests_run" ON "email_reply_requests" USING btree ("run_id");