-- Set sentinel userId on all existing volumes (scope-level shared resources)
UPDATE "storages" SET "user_id" = '__scope__' WHERE "type" = 'volume';--> statement-breakpoint
-- Drop old unique index (scopeId, name, type)
DROP INDEX "idx_storages_scope_name_type";--> statement-breakpoint
-- Create new unique index (scopeId, userId, name, type)
CREATE UNIQUE INDEX "idx_storages_scope_user_name_type" ON "storages" USING btree ("scope_id","user_id","name","type");
