ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "integrity_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "public_catalog_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "private_catalog_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "private_firewalls_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "runner_firewalls_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "public_catalog";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "private_catalog";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "private_firewalls";--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" DROP COLUMN "runner_firewalls";--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" DROP COLUMN "integrity_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" DROP COLUMN "last_observed_integrity_digest";--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" DROP COLUMN "last_rejected_integrity_digest";