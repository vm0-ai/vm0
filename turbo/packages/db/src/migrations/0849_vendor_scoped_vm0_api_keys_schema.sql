DROP INDEX "idx_vm0_api_keys_vendor";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_vm0_api_keys_vendor" ON "vm0_api_keys" USING btree ("vendor");--> statement-breakpoint
ALTER TABLE "vm0_api_keys" DROP COLUMN "model";