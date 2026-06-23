WITH ranked_triggers AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY automation_id
      ORDER BY created_at ASC, id ASC
    ) AS kept_id,
    row_number() OVER (
      PARTITION BY automation_id
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM automation_triggers
)
UPDATE zero_runs
SET trigger_id = ranked_triggers.kept_id
FROM ranked_triggers
WHERE zero_runs.trigger_id = ranked_triggers.id
  AND ranked_triggers.row_number > 1;--> statement-breakpoint
WITH ranked_triggers AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY automation_id
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM automation_triggers
)
DELETE FROM automation_triggers
USING ranked_triggers
WHERE automation_triggers.id = ranked_triggers.id
  AND ranked_triggers.row_number > 1;--> statement-breakpoint
DROP INDEX "idx_automation_triggers_automation";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_triggers_automation" ON "automation_triggers" USING btree ("automation_id");
