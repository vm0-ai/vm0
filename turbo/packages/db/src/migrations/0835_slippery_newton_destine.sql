ALTER TABLE "google_calendar_watch_states" ADD COLUMN "previous_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "google_calendar_watch_states" ADD COLUMN "previous_channel_token" varchar(255);--> statement-breakpoint
ALTER TABLE "google_calendar_watch_states" ADD COLUMN "previous_resource_id" varchar(255);