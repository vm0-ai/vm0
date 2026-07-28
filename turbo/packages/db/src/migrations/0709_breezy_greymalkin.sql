CREATE TABLE "usage_event_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processed_hour" timestamp NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"kind" varchar(30) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"category" varchar(100) NOT NULL,
	"short_window_id" uuid,
	"weekly_window_id" uuid,
	"quantity" bigint NOT NULL,
	"credits_charged" bigint NOT NULL,
	"allowance_units" bigint NOT NULL,
	CONSTRAINT "chk_usage_event_hourly_processed_hour" CHECK ("usage_event_hourly"."processed_hour" = date_trunc('hour', "usage_event_hourly"."processed_hour")),
	CONSTRAINT "chk_usage_event_hourly_quantity" CHECK ("usage_event_hourly"."quantity" >= 0),
	CONSTRAINT "chk_usage_event_hourly_credits_charged" CHECK ("usage_event_hourly"."credits_charged" >= 0),
	CONSTRAINT "chk_usage_event_hourly_allowance_units" CHECK ("usage_event_hourly"."allowance_units" >= 0),
	CONSTRAINT "chk_usage_event_hourly_allowance_window_pair" CHECK ((
          "usage_event_hourly"."allowance_units" = 0
          AND "usage_event_hourly"."short_window_id" IS NULL
          AND "usage_event_hourly"."weekly_window_id" IS NULL
        ) OR (
          "usage_event_hourly"."allowance_units" > 0
          AND "usage_event_hourly"."short_window_id" IS NOT NULL
          AND "usage_event_hourly"."weekly_window_id" IS NOT NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "usage_event_hourly" ADD CONSTRAINT "usage_event_hourly_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event_hourly" ADD CONSTRAINT "fk_usage_event_hourly_short_window" FOREIGN KEY ("short_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event_hourly" ADD CONSTRAINT "fk_usage_event_hourly_weekly_window" FOREIGN KEY ("weekly_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_org_hour" ON "usage_event_hourly" USING btree ("org_id","processed_hour");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_processed_org_user" ON "usage_event_hourly" USING btree ("processed_hour" DESC NULLS LAST,"org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_run_id" ON "usage_event_hourly" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_user_id" ON "usage_event_hourly" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_short_window_id" ON "usage_event_hourly" USING btree ("short_window_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_weekly_window_id" ON "usage_event_hourly" USING btree ("weekly_window_id");