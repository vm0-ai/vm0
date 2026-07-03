ALTER TABLE "org" RENAME TO "org_metadata";--> statement-breakpoint
ALTER TABLE "org_members" RENAME TO "org_members_metadata";--> statement-breakpoint
ALTER TABLE "org_metadata" RENAME CONSTRAINT "org_pkey" TO "org_metadata_pkey";--> statement-breakpoint
ALTER TABLE "org_members_metadata" RENAME CONSTRAINT "org_members_org_id_user_id_pk" TO "org_members_metadata_org_id_user_id_pk";--> statement-breakpoint
CREATE VIEW "org" AS SELECT * FROM "org_metadata";--> statement-breakpoint
CREATE VIEW "org_members" AS SELECT * FROM "org_members_metadata";
