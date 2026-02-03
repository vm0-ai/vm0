-- Add scope support to storages table
-- Follows the same pattern as agent_composes migration (0046)
-- This enables scope-based access control for storages (volumes and artifacts)

-- Step 1: Add scope_id column (nullable initially)
ALTER TABLE "storages" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");
--> statement-breakpoint

-- Step 2: Create index for scope lookups
CREATE INDEX IF NOT EXISTS "idx_storages_scope" ON "storages" USING btree ("scope_id");
--> statement-breakpoint

-- Step 3: Populate scope_id from user's personal scope
UPDATE "storages" st
SET "scope_id" = s.id
FROM "scopes" s
WHERE s.owner_id = st.user_id AND s.type = 'personal';
--> statement-breakpoint

-- Step 4: Make scope_id NOT NULL (all rows should have scope now)
ALTER TABLE "storages" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint

-- Step 5: Drop old unique index
DROP INDEX IF EXISTS "idx_storages_user_name_type";
--> statement-breakpoint

-- Step 6: Create new unique index on (scope_id, name, type)
CREATE UNIQUE INDEX "idx_storages_scope_name_type"
  ON "storages" ("scope_id", "name", "type");
