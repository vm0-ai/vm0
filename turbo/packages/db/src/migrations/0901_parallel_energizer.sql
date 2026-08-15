-- vm0:non-transactional
-- An interrupted concurrent build can leave an invalid shadow index behind.
DROP INDEX CONCURRENTLY IF EXISTS "idx_variables_org_user_type_name_0901";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "idx_variables_org_user_type_name_0901"
  ON "variables" USING btree ("org_id", "user_id", "type", "name")
  WHERE "variables"."connector_id" IS NULL;
--> statement-breakpoint
-- Keep the stronger global index active through the online build, then replace
-- it atomically so no transaction observes a user-variable uniqueness gap.
DO $$
BEGIN
  EXECUTE 'DROP INDEX "idx_variables_org_user_type_name"';
  EXECUTE 'ALTER INDEX "idx_variables_org_user_type_name_0901"
    RENAME TO "idx_variables_org_user_type_name"';
END
$$;
