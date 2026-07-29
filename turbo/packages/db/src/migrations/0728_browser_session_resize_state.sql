ALTER TABLE "browser_session_instances" ADD COLUMN "resizable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD COLUMN "screen_width" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD COLUMN "screen_height" integer DEFAULT 900 NOT NULL;