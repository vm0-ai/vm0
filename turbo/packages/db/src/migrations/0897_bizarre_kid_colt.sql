-- vm0:non-transactional
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'fk_variables_connector_owner'
      AND "conrelid" = 'public.variables'::regclass
  ) THEN
    ALTER TABLE "variables"
      ADD CONSTRAINT "fk_variables_connector_owner"
      FOREIGN KEY ("connector_id", "org_id", "user_id")
      REFERENCES "connectors" ("id", "org_id", "user_id")
      ON DELETE CASCADE
      ON UPDATE NO ACTION
      NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "variables"
  VALIDATE CONSTRAINT "fk_variables_connector_owner";
--> statement-breakpoint
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop the new index name first so the full migration is safe to retry.
DROP INDEX CONCURRENTLY IF EXISTS "idx_variables_connector_name";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "idx_variables_connector_name"
  ON "variables" USING btree ("connector_id", "name")
  WHERE "variables"."connector_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "variables"
  DROP CONSTRAINT IF EXISTS "variables_connector_id_connectors_id_fk";
