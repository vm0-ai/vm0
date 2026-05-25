ALTER TABLE "agent_composes" DROP CONSTRAINT "agent_composes_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_composes" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "cli_tokens" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "secrets" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "storages" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "variables" DROP COLUMN "scope_id";