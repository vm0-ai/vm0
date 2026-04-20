-- Add scope support to agent_composes table
-- Follows the same pattern as images table

-- Step 1: Add scope_id column (nullable initially)
ALTER TABLE "agent_composes" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");
--> statement-breakpoint

-- Step 2: Create index for scope lookups
CREATE INDEX IF NOT EXISTS "idx_agent_composes_scope" ON "agent_composes" USING btree ("scope_id");
--> statement-breakpoint

-- Step 3: Populate scope_id from user's personal scope
UPDATE "agent_composes" ac
SET "scope_id" = s.id
FROM "scopes" s
WHERE s.owner_id = ac.user_id AND s.type = 'personal';
--> statement-breakpoint

-- Step 4: Make scope_id NOT NULL (all rows should have scope now)
ALTER TABLE "agent_composes" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint

-- Step 5: Drop old unique index
DROP INDEX IF EXISTS "idx_agent_composes_user_name";
--> statement-breakpoint

-- Step 6: Create new unique index on (scope_id, name)
CREATE UNIQUE INDEX "idx_agent_composes_scope_name"
  ON "agent_composes" ("scope_id", "name");
