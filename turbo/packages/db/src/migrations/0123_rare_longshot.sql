ALTER TABLE "agent_schedules" DROP CONSTRAINT "agent_schedules_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "model_providers" DROP CONSTRAINT "model_providers_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_id_scopes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_agent_schedules_compose_name_scope_user";--> statement-breakpoint
DROP INDEX "idx_agent_schedules_scope_user";--> statement-breakpoint
DROP INDEX "idx_connectors_scope_user_type";--> statement-breakpoint
DROP INDEX "idx_connectors_scope";--> statement-breakpoint
DROP INDEX "idx_model_providers_scope_user_type";--> statement-breakpoint
DROP INDEX "idx_model_providers_scope";--> statement-breakpoint
DROP INDEX "idx_secrets_scope_user_name_type";--> statement-breakpoint
DROP INDEX "idx_secrets_scope";