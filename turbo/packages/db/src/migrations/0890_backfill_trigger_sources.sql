-- 1. Goals first. This predicate only works while 'workflow-event' still
--    distinguishes them; step 2 destroys it.
UPDATE "zero_runs" SET "trigger_source" = 'goal'
WHERE "trigger_source" = 'workflow-event'
  AND "goal_id" IS NOT NULL;--> statement-breakpoint

-- 2. Everything still labelled workflow-event is a real automation event.
UPDATE "zero_runs" SET "trigger_source" = 'automation-event'
WHERE "trigger_source" = 'workflow-event';--> statement-breakpoint

UPDATE "zero_runs" SET "trigger_source" = 'automation-schedule'
WHERE "trigger_source" = 'workflow-schedule';--> statement-breakpoint

-- 3. run_uploaded_files.source mirrors the run's trigger source, so derive it
--    from the already-corrected zero_runs rather than repeating the split.
UPDATE "run_uploaded_files" f SET "source" = r."trigger_source"
FROM "zero_runs" r
WHERE f."run_id" = r."id"
  AND f."source" IN ('workflow-event', 'workflow-schedule')
  AND r."trigger_source" IN ('automation-event', 'automation-schedule', 'goal');--> statement-breakpoint

-- 4. run_id is nullable and the run may have been deleted, so any row the join
--    could not reach gets the blanket rename. These cannot be classified as
--    goals -- there is no run left to ask.
UPDATE "run_uploaded_files" SET "source" = 'automation-event'
WHERE "source" = 'workflow-event';--> statement-breakpoint

UPDATE "run_uploaded_files" SET "source" = 'automation-schedule'
WHERE "source" = 'workflow-schedule';
