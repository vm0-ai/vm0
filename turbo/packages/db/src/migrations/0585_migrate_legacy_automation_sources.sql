-- Legacy Automation cleanup (#21184, PR 6). The production baseline before
-- this migration was 6,508 zero_runs rows and 333 run_uploaded_files rows.
-- Fifty-nine historical runs span four orgs outside the maintained internal
-- allowlist; they receive the same classification-only rewrite.
-- This is a classification-only rewrite: historical runs intentionally keep
-- their NULL workflow_trigger_id because no Workflow Automation linkage was
-- recovered for them.
UPDATE "zero_runs"
SET "trigger_source" = 'workflow-schedule'
WHERE "trigger_source" = 'automation';--> statement-breakpoint

-- schedule/automation are stale uploaded-file attribution values. PR 4 made
-- workflow-schedule a supported source before this migration was introduced.
UPDATE "run_uploaded_files"
SET "source" = 'workflow-schedule'
WHERE "source" IN ('schedule', 'automation');
