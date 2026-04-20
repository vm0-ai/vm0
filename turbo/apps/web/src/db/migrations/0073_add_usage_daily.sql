-- Pre-aggregated daily usage statistics per user
-- Populated by /api/cron/aggregate-usage cron job

CREATE TABLE "usage_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "date" date NOT NULL,
  "run_count" integer NOT NULL DEFAULT 0,
  "run_time_ms" bigint NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uq_usage_daily_user_date" ON "usage_daily" USING btree ("user_id", "date");
