CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address" text NOT NULL,
	"reason" text NOT NULL,
	"resend_email_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_email_lower_idx" ON "email_suppressions" USING btree (lower("email_address"));