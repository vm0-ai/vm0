CREATE TABLE "desktop_auth_handoff_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "desktop_auth_handoff_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_desktop_auth_handoff_codes_expires" ON "desktop_auth_handoff_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_desktop_auth_handoff_codes_user_created" ON "desktop_auth_handoff_codes" USING btree ("user_id","created_at");