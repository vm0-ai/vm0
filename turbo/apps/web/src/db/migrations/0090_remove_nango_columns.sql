DROP INDEX "idx_connectors_platform";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "platform";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "nango_connection_id";