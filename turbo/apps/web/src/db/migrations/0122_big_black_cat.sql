ALTER TABLE "storages" DROP CONSTRAINT "storages_scope_id_scopes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_storages_scope_user_name_type";--> statement-breakpoint
DROP INDEX "idx_storages_scope";