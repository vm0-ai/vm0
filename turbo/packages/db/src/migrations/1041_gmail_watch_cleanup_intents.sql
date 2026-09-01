CREATE TABLE "gmail_watch_cleanup_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_key" text NOT NULL,
	"provider_account_id" varchar(255),
	"email_address" varchar(320) NOT NULL,
	"topic_names" text[] NOT NULL,
	"auth_method" varchar(50) NOT NULL,
	"storage_version" bigint NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"access_token_expires_at" timestamp,
	"watch_expiration_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gmail_watch_cleanup_intents_mailbox" ON "gmail_watch_cleanup_intents" USING btree ("mailbox_key");--> statement-breakpoint
CREATE INDEX "idx_gmail_watch_cleanup_intents_expiration" ON "gmail_watch_cleanup_intents" USING btree ("watch_expiration_at");--> statement-breakpoint
CREATE INDEX "idx_gmail_watch_cleanup_intents_provider_account" ON "gmail_watch_cleanup_intents" USING btree ("provider_account_id");