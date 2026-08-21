-- vm0:non-transactional
SET lock_timeout = '1s';
SET statement_timeout = '10s';
--> statement-breakpoint
UPDATE "connectors"
SET "is_default" = true
WHERE "is_default" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_connectors_is_default_not_null'
      AND conrelid = 'connectors'::regclass
  ) THEN
    ALTER TABLE "connectors"
    ADD CONSTRAINT "chk_connectors_is_default_not_null"
    CHECK ("is_default" IS NOT NULL) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
SET statement_timeout = '0';
ALTER TABLE "connectors"
VALIDATE CONSTRAINT "chk_connectors_is_default_not_null";
--> statement-breakpoint
SET statement_timeout = '10s';
ALTER TABLE "connectors" ALTER COLUMN "is_default" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "connectors"
DROP CONSTRAINT IF EXISTS "chk_connectors_is_default_not_null";
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_connectors_org_user_custom_connector";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_connectors_org_user_custom_connector"
ON "connectors" USING btree (
  "org_id", "user_id", "custom_connector_id", "created_at", "id"
) WHERE "custom_connector_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_connectors_org_user_slug";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_connectors_org_user_slug"
ON "connectors" USING btree (
  "org_id", "user_id", "connector_slug", "created_at", "id"
) WHERE "connector_slug" IS NOT NULL;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
