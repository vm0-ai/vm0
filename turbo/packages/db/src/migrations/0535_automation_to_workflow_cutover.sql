-- Automation -> workflow cutover (vm0-ai/vm0#19959, PR-2).
--
-- Migrates every legacy automation into a private workflow + schedule trigger
-- and freezes the legacy rows. The SKILL.md volumes (custom-skill@{id}) were
-- preseeded ahead of this release by scripts/migrations/008; the workflow id
-- REUSES the automation id, so those volumes attach with no further I/O.
--
-- Rules (decided on the issue):
--   - name: slug-normalized automation name; `wf-` + first 8 id chars when the
--     normalized slug is shorter than 2 chars. Must match the preseed script.
--   - instruction: automation instruction, with a non-blank
--     append_system_prompt appended under "## Additional instructions".
--   - migrated trigger enabled = automations.enabled AND automation_triggers.enabled.
--   - trigger scheduling state (next_run_at / last_run_at / last_run_id /
--     consecutive_failures) carried verbatim; the trigger id is reused too.
--   - the legacy chat thread becomes the workflow's trigger thread.
--   - legacy automation_triggers are disabled WITHOUT clearing next_run_at
--     (frozen in place; cheap manual rollback), which also neutralizes the
--     in-flight-run completion callback (it re-arms only enabled triggers).
--
-- Guards: automations whose agent has no zero_agents row, or whose normalized
-- slug would collide within the private-workflow uniqueness scope, are left
-- unmigrated (migrated_to_workflow_id stays NULL) and keep working through the
-- legacy poller; the post-release reconciliation query surfaces them for
-- manual handling. Both sets are expected to be empty (verified via mask-db).
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING keyed by reused ids; the
-- UPDATEs are no-ops on already-migrated rows.

WITH candidates AS (
  SELECT
    a.*,
    btrim(
      regexp_replace(
        regexp_replace(lower(a."name"), '[^a-z0-9-]+', '-', 'g'),
        '-+', '-', 'g'
      ),
      '-'
    ) AS raw_slug
  FROM "automations" a
  JOIN "zero_agents" za ON za."id" = a."agent_id"
  WHERE a."migrated_to_workflow_id" IS NULL
),
sluggified AS (
  SELECT
    c.*,
    CASE
      WHEN length(c.raw_slug) >= 2 THEN c.raw_slug
      ELSE 'wf-' || substr(c."id"::text, 1, 8)
    END AS slug
  FROM candidates c
),
-- Drop rows whose slug collides with a sibling candidate or an existing
-- private workflow in the same (org, agent, owner) scope.
deduped AS (
  SELECT s.*
  FROM sluggified s
  WHERE NOT EXISTS (
    SELECT 1 FROM sluggified other
    WHERE other."org_id" = s."org_id"
      AND other."agent_id" = s."agent_id"
      AND other."user_id" = s."user_id"
      AND other.slug = s.slug
      AND other."id" <> s."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "zero_workflows" w
    WHERE w."org_id" = s."org_id"
      AND w."agent_id" = s."agent_id"
      AND w."owner_user_id" = s."user_id"
      AND w."name" = s.slug
      AND w."visibility" = 'private'
      AND w."id" <> s."id"
  )
)
INSERT INTO "zero_workflows" (
  "id", "org_id", "agent_id", "name", "visibility", "instruction",
  "owner_user_id", "display_name", "description",
  "created_by", "updated_by", "created_at", "updated_at"
)
SELECT
  d."id",
  d."org_id",
  d."agent_id",
  d.slug,
  'private',
  CASE
    WHEN d."append_system_prompt" IS NOT NULL
     AND btrim(d."append_system_prompt") <> ''
    THEN d."instruction" || E'\n\n## Additional instructions\n\n' || d."append_system_prompt"
    ELSE d."instruction"
  END,
  d."user_id",
  left(d."name", 256),
  d."description",
  d."user_id",
  d."user_id",
  d."created_at",
  now()
FROM deduped d
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Schedule triggers: reuse the legacy trigger id; map kind -> schedule_type
-- 1:1 and null out non-matching config fields to satisfy the CHECK constraint.
INSERT INTO "zero_workflow_triggers" (
  "id", "org_id", "workflow_id", "owner_user_id", "kind",
  "schedule_type", "cron_expression", "interval_seconds", "at_time",
  "timezone", "enabled", "next_run_at", "last_run_at", "last_run_id",
  "consecutive_failures", "created_at", "updated_at"
)
SELECT
  t."id",
  a."org_id",
  w."id",
  a."user_id",
  'schedule',
  t."kind",
  CASE WHEN t."kind" = 'cron' THEN t."cron_expression" END,
  CASE WHEN t."kind" = 'loop' THEN t."interval_seconds" END,
  CASE WHEN t."kind" = 'once' THEN t."at_time" END,
  t."timezone",
  (a."enabled" AND t."enabled"),
  t."next_run_at",
  t."last_run_at",
  t."last_run_id",
  t."consecutive_failures",
  t."created_at",
  now()
FROM "automation_triggers" t
JOIN "automations" a ON a."id" = t."automation_id"
JOIN "zero_workflows" w ON w."id" = a."id"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- The legacy chat thread becomes the workflow's shared trigger thread,
-- preserving conversation history and the thread's model pin.
INSERT INTO "workflow_user_trigger_threads" (
  "org_id", "user_id", "workflow_id", "chat_thread_id", "created_at", "updated_at"
)
SELECT a."org_id", a."user_id", w."id", a."chat_thread_id", now(), now()
FROM "automations" a
JOIN "zero_workflows" w ON w."id" = a."id"
ON CONFLICT ("org_id", "user_id", "workflow_id") DO NOTHING;--> statement-breakpoint

-- Provenance stamp: id equality is the mapping; the column makes it explicit.
UPDATE "automations" a
SET "migrated_to_workflow_id" = w."id", "updated_at" = now()
FROM "zero_workflows" w
WHERE w."id" = a."id"
  AND a."migrated_to_workflow_id" IS NULL;--> statement-breakpoint

-- Freeze legacy scheduling. next_run_at is intentionally kept: it makes the
-- manual rollback documented on #19959 a plain re-enable, and the disabled
-- flag alone stops both the poller and the completion-callback re-arm.
UPDATE "automation_triggers" t
SET "enabled" = false, "updated_at" = now()
FROM "automations" a
WHERE a."id" = t."automation_id"
  AND a."migrated_to_workflow_id" IS NOT NULL
  AND t."enabled" = true;
