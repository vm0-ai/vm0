ALTER TABLE "org" RENAME TO "org_metadata";--> statement-breakpoint
ALTER TABLE "org_members" RENAME TO "org_members_metadata";--> statement-breakpoint
ALTER TABLE "org_members_metadata" RENAME CONSTRAINT "org_members_org_id_user_id_pk" TO "org_members_metadata_org_id_user_id_pk";