CREATE TABLE "system_storage_presigned_url_cache" (
	"cache_key" varchar(64) PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"storage_version_id" varchar(64) NOT NULL,
	"public_endpoint" boolean NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"presigned_url" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"refresh_after" timestamp NOT NULL,
	"last_requested_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_system_storage_presigned_url_cache_refresh_after" ON "system_storage_presigned_url_cache" USING btree ("refresh_after");--> statement-breakpoint
CREATE INDEX "idx_system_storage_presigned_url_cache_last_requested_at" ON "system_storage_presigned_url_cache" USING btree ("last_requested_at");--> statement-breakpoint
CREATE INDEX "idx_system_storage_presigned_url_cache_active_refresh" ON "system_storage_presigned_url_cache" USING btree ("last_requested_at","refresh_after");