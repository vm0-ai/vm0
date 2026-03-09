ALTER TABLE "agent_composes" DROP CONSTRAINT "agent_composes_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_default_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_installations" DROP CONSTRAINT "slack_installations_default_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "storages" DROP CONSTRAINT "storages_scope_id_scopes_id_fk";
--> statement-breakpoint
ALTER TABLE "telegram_installations" DROP CONSTRAINT "telegram_installations_default_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_scope_id_scopes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_users_scope";--> statement-breakpoint
ALTER TABLE "agent_composes" ADD CONSTRAINT "agent_composes_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storages" ADD CONSTRAINT "storages_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD CONSTRAINT "telegram_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "scope_id";