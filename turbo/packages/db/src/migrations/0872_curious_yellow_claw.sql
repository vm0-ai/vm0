DROP TABLE "agent_run_custom_connector_auth_refs";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_revision_positive";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP COLUMN "connector_revision";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP COLUMN "connector_revision";
