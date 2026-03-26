CREATE TABLE "zero_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger_source" varchar(20) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_id_agent_runs_id_fk" FOREIGN KEY ("id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "zero_runs" ("id", "trigger_source")
SELECT
  "id",
  COALESCE(
    "trigger_source",
    CASE
      WHEN "schedule_id" IS NOT NULL THEN 'schedule'
      WHEN "continued_from_session_id" IS NOT NULL THEN 'web'
      ELSE 'cli'
    END
  )
FROM "agent_runs";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "trigger_source";
