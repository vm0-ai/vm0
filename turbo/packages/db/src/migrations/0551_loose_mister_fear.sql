ALTER TABLE "system_storage_presigned_url_cache" ADD COLUMN "scope" varchar(64) DEFAULT 'system_storage' NOT NULL;--> statement-breakpoint
ALTER TABLE "system_storage_presigned_url_cache" ADD COLUMN "resolved_org_id" text;--> statement-breakpoint
CREATE INDEX "idx_system_storage_presigned_url_cache_scope_refresh_after" ON "system_storage_presigned_url_cache" USING btree ("scope","refresh_after");--> statement-breakpoint
CREATE INDEX "idx_system_storage_presigned_url_cache_scope_active_refresh" ON "system_storage_presigned_url_cache" USING btree ("scope","last_requested_at","refresh_after");