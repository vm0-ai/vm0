CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"cc_addresses" jsonb,
	"subject" text NOT NULL,
	"reply_to" text,
	"headers" jsonb,
	"template" jsonb NOT NULL,
	"post_send_action" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp,
	"resend_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_outbox_drain_idx" ON "email_outbox" USING btree ("status","next_retry_at","created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_created_at_idx" ON "email_outbox" USING btree ("created_at");