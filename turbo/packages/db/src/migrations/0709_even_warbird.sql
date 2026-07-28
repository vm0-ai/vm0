CREATE TABLE "usage_event_hourly_rollup" (
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
	CONSTRAINT "chk_usage_event_hourly_rollup_processed_hour" CHECK ("usage_event_hourly_rollup"."processed_hour" = date_trunc('hour', "usage_event_hourly_rollup"."processed_hour")),
	CONSTRAINT "chk_usage_event_hourly_rollup_quantity" CHECK ("usage_event_hourly_rollup"."quantity" >= 0),
	CONSTRAINT "chk_usage_event_hourly_rollup_credits_charged" CHECK ("usage_event_hourly_rollup"."credits_charged" >= 0),
	CONSTRAINT "chk_usage_event_hourly_rollup_allowance_units" CHECK ("usage_event_hourly_rollup"."allowance_units" >= 0),
	CONSTRAINT "chk_usage_event_hourly_rollup_allowance_window_pair" CHECK ((
          "usage_event_hourly_rollup"."allowance_units" = 0
          AND "usage_event_hourly_rollup"."short_window_id" IS NULL
          AND "usage_event_hourly_rollup"."weekly_window_id" IS NULL
        ) OR (
          "usage_event_hourly_rollup"."allowance_units" > 0
          AND "usage_event_hourly_rollup"."short_window_id" IS NOT NULL
          AND "usage_event_hourly_rollup"."weekly_window_id" IS NOT NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "usage_event_hourly_rollup_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "fk_usage_event_hourly_rollup_short_window" FOREIGN KEY ("short_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "fk_usage_event_hourly_rollup_weekly_window" FOREIGN KEY ("weekly_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_org_hour" ON "usage_event_hourly_rollup" USING btree ("org_id","processed_hour");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_processed_org_user" ON "usage_event_hourly_rollup" USING btree ("processed_hour" DESC NULLS LAST,"org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_run_id" ON "usage_event_hourly_rollup" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_user_id" ON "usage_event_hourly_rollup" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_short_window_id" ON "usage_event_hourly_rollup" USING btree ("short_window_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_weekly_window_id" ON "usage_event_hourly_rollup" USING btree ("weekly_window_id");