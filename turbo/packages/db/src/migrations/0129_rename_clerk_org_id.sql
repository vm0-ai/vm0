-- Rename clerk_org_id to org_id across all tables
ALTER TABLE "scopes" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "agent_composes" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "agent_schedules" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "cli_tokens" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "connectors" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "model_providers" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "org_cache" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "org_members_cache" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "secrets" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "storages" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "variables" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
-- Rename indexes
ALTER INDEX "idx_scopes_clerk_org" RENAME TO "idx_scopes_org";--> statement-breakpoint
ALTER INDEX "idx_agent_composes_clerk_org" RENAME TO "idx_agent_composes_org";--> statement-breakpoint
ALTER INDEX "idx_agent_composes_clerk_org_name" RENAME TO "idx_agent_composes_org_name";--> statement-breakpoint
ALTER INDEX "idx_agent_runs_clerk_org" RENAME TO "idx_agent_runs_org";--> statement-breakpoint
ALTER INDEX "idx_agent_schedules_clerk_org" RENAME TO "idx_agent_schedules_org";--> statement-breakpoint
ALTER INDEX "idx_agent_schedules_compose_name_clerk_org_user" RENAME TO "idx_agent_schedules_compose_name_org_user";--> statement-breakpoint
ALTER INDEX "idx_connectors_clerk_org" RENAME TO "idx_connectors_org";--> statement-breakpoint
ALTER INDEX "idx_connectors_clerk_org_user_type" RENAME TO "idx_connectors_org_user_type";--> statement-breakpoint
ALTER INDEX "idx_model_providers_clerk_org" RENAME TO "idx_model_providers_org";--> statement-breakpoint
ALTER INDEX "idx_model_providers_clerk_org_user_type" RENAME TO "idx_model_providers_org_user_type";--> statement-breakpoint
ALTER INDEX "idx_secrets_clerk_org" RENAME TO "idx_secrets_org";--> statement-breakpoint
ALTER INDEX "idx_secrets_clerk_org_user_name_type" RENAME TO "idx_secrets_org_user_name_type";--> statement-breakpoint
ALTER INDEX "idx_storages_clerk_org" RENAME TO "idx_storages_org";--> statement-breakpoint
ALTER INDEX "idx_storages_clerk_org_user_name_type" RENAME TO "idx_storages_org_user_name_type";--> statement-breakpoint
ALTER INDEX "idx_variables_clerk_org" RENAME TO "idx_variables_org";--> statement-breakpoint
ALTER INDEX "idx_variables_clerk_org_user_name" RENAME TO "idx_variables_org_user_name";--> statement-breakpoint
-- Rename primary key constraint index
ALTER INDEX "org_members_cache_clerk_org_id_user_id_pk" RENAME TO "org_members_cache_org_id_user_id_pk";
