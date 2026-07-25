ALTER TABLE "browser_session_instances" ADD COLUMN "billing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD COLUMN "last_touched_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD COLUMN "idle_expires_at" timestamp DEFAULT now() NOT NULL;