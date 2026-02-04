-- Support orphaned bindings during logout/login cycle
-- This allows users to retain their agent configurations after logout

-- Add vm0_user_id column to identify binding owner
ALTER TABLE "slack_bindings" ADD COLUMN "vm0_user_id" text;

-- Add slack_workspace_id column for scoping lookups
ALTER TABLE "slack_bindings" ADD COLUMN "slack_workspace_id" varchar(255);

-- Backfill existing records from slack_user_links
UPDATE "slack_bindings" b
SET
  "vm0_user_id" = l."vm0_user_id",
  "slack_workspace_id" = l."slack_workspace_id"
FROM "slack_user_links" l
WHERE b."slack_user_link_id" = l."id";

-- Make columns NOT NULL after backfill
ALTER TABLE "slack_bindings" ALTER COLUMN "vm0_user_id" SET NOT NULL;
ALTER TABLE "slack_bindings" ALTER COLUMN "slack_workspace_id" SET NOT NULL;

-- Drop the existing foreign key constraint
ALTER TABLE "slack_bindings" DROP CONSTRAINT IF EXISTS "slack_bindings_slack_user_link_id_slack_user_links_id_fk";

-- Allow slack_user_link_id to be NULL
ALTER TABLE "slack_bindings" ALTER COLUMN "slack_user_link_id" DROP NOT NULL;

-- Re-add foreign key with SET NULL on delete
ALTER TABLE "slack_bindings"
  ADD CONSTRAINT "slack_bindings_slack_user_link_id_slack_user_links_id_fk"
  FOREIGN KEY ("slack_user_link_id")
  REFERENCES "slack_user_links"("id")
  ON DELETE SET NULL;

-- Add index for finding orphaned bindings by user
CREATE INDEX "idx_slack_bindings_vm0_user_workspace"
  ON "slack_bindings"("vm0_user_id", "slack_workspace_id");
