DROP INDEX "idx_slack_org_connections_vm0_user_org";--> statement-breakpoint
CREATE INDEX "idx_slack_org_connections_vm0_user_workspace" ON "slack_org_connections" USING btree ("vm0_user_id","slack_workspace_id");--> statement-breakpoint
ALTER TABLE "slack_org_connections" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" DROP COLUMN "org_id";