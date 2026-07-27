CREATE TABLE "usage_event_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processed_hour" timestamp NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"kind" varchar(30) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"category" varchar(100) NOT NULL,
	"quantity" bigint NOT NULL,
	"credits_charged" bigint NOT NULL,
	"allowance_units" bigint NOT NULL,
	"source_event_count" bigint NOT NULL,
	"max_processed_at" timestamp NOT NULL,
	"compacted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_event_hourly_processed_hour" CHECK ("usage_event_hourly"."processed_hour" = date_trunc('hour', "usage_event_hourly"."processed_hour")),
	CONSTRAINT "chk_usage_event_hourly_quantity" CHECK ("usage_event_hourly"."quantity" >= 0),
	CONSTRAINT "chk_usage_event_hourly_credits_charged" CHECK ("usage_event_hourly"."credits_charged" >= 0),
	CONSTRAINT "chk_usage_event_hourly_allowance_units" CHECK ("usage_event_hourly"."allowance_units" >= 0),
	CONSTRAINT "chk_usage_event_hourly_source_event_count" CHECK ("usage_event_hourly"."source_event_count" > 0),
	CONSTRAINT "chk_usage_event_hourly_max_processed_at" CHECK ("usage_event_hourly"."max_processed_at" >= "usage_event_hourly"."processed_hour" AND "usage_event_hourly"."max_processed_at" < "usage_event_hourly"."processed_hour" + interval '1 hour')
);
--> statement-breakpoint
ALTER TABLE "usage_event_hourly" ADD CONSTRAINT "usage_event_hourly_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_org_hour" ON "usage_event_hourly" USING btree ("org_id","processed_hour");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_processed_org_user" ON "usage_event_hourly" USING btree ("processed_hour" DESC NULLS LAST,"org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_run_id" ON "usage_event_hourly" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_user_id" ON "usage_event_hourly" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_usage_event_id" ON "browser_session_instances" USING btree ("usage_event_id");--> statement-breakpoint
CREATE VIEW "public"."usage_event_finalized" AS (
  SELECT
    "usage_event"."org_id" AS org_id,
    "usage_event"."user_id" AS user_id,
    "usage_event"."run_id" AS run_id,
    "usage_event"."kind" AS kind,
    "usage_event"."provider" AS provider,
    "usage_event"."category" AS category,
    "usage_event"."quantity" AS quantity,
    COALESCE("usage_event"."credits_charged", 0)::bigint AS credits_charged,
    COALESCE("usage_allowance_allocations"."units_applied", 0)::bigint AS allowance_units,
    1::bigint AS source_event_count,
    "usage_event"."processed_at" AS activity_at,
    date_trunc('hour', "usage_event"."processed_at") AS processed_hour,
    "usage_event"."processed_at" AS max_processed_at,
    COALESCE("usage_event"."processed_at", "usage_event"."created_at") AS settled_at
  FROM "usage_event"
  LEFT JOIN "usage_allowance_allocations"
    ON "usage_allowance_allocations"."usage_event_id" = "usage_event"."id"
  WHERE "usage_event"."status" = 'processed'

  UNION ALL

  SELECT
    "usage_event_hourly"."org_id" AS org_id,
    "usage_event_hourly"."user_id" AS user_id,
    "usage_event_hourly"."run_id" AS run_id,
    "usage_event_hourly"."kind" AS kind,
    "usage_event_hourly"."provider" AS provider,
    "usage_event_hourly"."category" AS category,
    "usage_event_hourly"."quantity" AS quantity,
    "usage_event_hourly"."credits_charged" AS credits_charged,
    "usage_event_hourly"."allowance_units" AS allowance_units,
    "usage_event_hourly"."source_event_count" AS source_event_count,
    "usage_event_hourly"."processed_hour" AS activity_at,
    "usage_event_hourly"."processed_hour" AS processed_hour,
    "usage_event_hourly"."max_processed_at" AS max_processed_at,
    "usage_event_hourly"."max_processed_at" AS settled_at
  FROM "usage_event_hourly"
);