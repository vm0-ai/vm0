CREATE TABLE "browser_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_token_hash" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_thread_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "browser_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "browser_thread_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "cloud_browser_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "cloud_browser_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_authorization_requests_token_hash" ON "browser_authorization_requests" USING btree ("request_token_hash");--> statement-breakpoint
CREATE INDEX "idx_browser_authorization_requests_owner" ON "browser_authorization_requests" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_authorization_requests_expires" ON "browser_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_thread_profiles_thread" ON "browser_thread_profiles" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_thread_profiles_provider_profile" ON "browser_thread_profiles" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "idx_browser_thread_profiles_owner" ON "browser_thread_profiles" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_browser_thread_profile_id_browser_thread_profiles_id_fk" FOREIGN KEY ("browser_thread_profile_id") REFERENCES "public"."browser_thread_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_profile_scope_check" CHECK (num_nonnulls("browser_sessions"."browser_profile_id", "browser_sessions"."browser_thread_profile_id") = 1);--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD CONSTRAINT "chat_thread_events_computer_access_check" CHECK (NOT ("chat_thread_events"."cloud_browser_enabled" AND "chat_thread_events"."computer_use_host_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_computer_access_check" CHECK (NOT ("chat_threads"."cloud_browser_enabled" AND "chat_threads"."computer_use_host_id" IS NOT NULL));