CREATE TABLE IF NOT EXISTS "user_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_secrets_user_name" ON "user_secrets" USING btree ("user_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_secrets_user_id" ON "user_secrets" USING btree ("user_id");
