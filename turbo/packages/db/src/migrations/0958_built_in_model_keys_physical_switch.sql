DROP VIEW "built_in_model_keys";
--> statement-breakpoint
ALTER TABLE "vm0_api_keys" RENAME TO "built_in_model_keys";
--> statement-breakpoint
ALTER TABLE "built_in_model_keys" RENAME CONSTRAINT "vm0_api_keys_pkey" TO "built_in_model_keys_pkey";
--> statement-breakpoint
ALTER INDEX "idx_vm0_api_keys_vendor" RENAME TO "idx_built_in_model_keys_vendor";
--> statement-breakpoint
CREATE VIEW "vm0_api_keys" AS
SELECT
	"id",
	"vendor",
	"api_key",
	"label",
	"created_at",
	"updated_at"
FROM "built_in_model_keys";
