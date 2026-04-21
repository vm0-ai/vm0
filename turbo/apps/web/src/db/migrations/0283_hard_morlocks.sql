CREATE TABLE "resend_contact_mapping" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"resend_contact_id" text NOT NULL,
	"last_email" text NOT NULL,
	"last_first_name" text,
	"last_last_name" text,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resend_contact_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"op" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text,
	"first_name" text,
	"last_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resend_contact_outbox_drain_idx" ON "resend_contact_outbox" USING btree ("status","next_retry_at","created_at");--> statement-breakpoint
CREATE INDEX "resend_contact_outbox_created_at_idx" ON "resend_contact_outbox" USING btree ("created_at");