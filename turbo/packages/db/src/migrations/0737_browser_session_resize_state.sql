CREATE TABLE "browser_session_resize_states" (
	"provider_session_id" uuid PRIMARY KEY NOT NULL,
	"screen_width" integer NOT NULL,
	"screen_height" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_session_resize_states" ADD CONSTRAINT "browser_session_resize_states_provider_session_id_browser_session_instances_provider_session_id_fk" FOREIGN KEY ("provider_session_id") REFERENCES "public"."browser_session_instances"("provider_session_id") ON DELETE cascade ON UPDATE no action;