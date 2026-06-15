-- Add scope_id to images table
-- Links images to their owning scope for namespace isolation

ALTER TABLE "images" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");

-- Create index for scope lookups
CREATE INDEX IF NOT EXISTS "idx_images_scope" ON "images" USING btree ("scope_id");
