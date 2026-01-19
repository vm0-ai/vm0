-- Add images table for user-built E2B templates
CREATE TABLE IF NOT EXISTS "images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "alias" varchar(64) NOT NULL,
  "e2b_alias" varchar(128) NOT NULL,
  "e2b_template_id" varchar(64),
  "e2b_build_id" varchar(64) NOT NULL,
  "status" varchar(16) DEFAULT 'building' NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Create unique index on (user_id, alias) for user isolation
CREATE UNIQUE INDEX IF NOT EXISTS "idx_images_user_alias" ON "images" USING btree ("user_id", "alias");
