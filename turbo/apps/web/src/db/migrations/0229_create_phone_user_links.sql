CREATE TABLE IF NOT EXISTS "phone_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"org_id" text NOT NULL,
	"vm0_user_id" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"otp_hash" varchar(128),
	"otp_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_phone_user_links_phone_org" ON "phone_user_links" USING btree ("phone_number","org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_phone_user_links_org_user" ON "phone_user_links" USING btree ("org_id","vm0_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_phone_user_links_org_phone" ON "phone_user_links" USING btree ("org_id","phone_number");
