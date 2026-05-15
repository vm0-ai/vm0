-- Remove agent_composes rows that have no matching zero_agents metadata and no
-- user activity/integration references. These rows can be produced when a Zero
-- agent create fails after compose creation; /api/zero/team used to list them,
-- but /api/zero/agents/:id cannot load them.
--
-- The dependency guards keep legacy compose-only records with history intact.
WITH orphan_agent_composes AS MATERIALIZED (
  SELECT c."id", c."org_id", c."name"
  FROM "agent_composes" c
  WHERE NOT EXISTS (
      SELECT 1 FROM "zero_agents" z
      WHERE z."id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "agent_compose_versions" v
      INNER JOIN "agent_runs" r
        ON r."agent_compose_version_id" = v."id"
      WHERE v."compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agent_sessions" s
      WHERE s."agent_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "chat_threads" t
      WHERE t."agent_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "email_thread_sessions" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "github_installations" i
      WHERE i."default_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "org_metadata" m
      WHERE m."default_agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "telegram_installations" i
      WHERE i."default_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "zero_agent_schedules" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "voice_chat_sessions" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "zero_runs" r
      WHERE r."trigger_agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agentphone_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "slack_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "telegram_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
)
UPDATE "storages" s
SET "head_version_id" = NULL
FROM orphan_agent_composes o
WHERE s."org_id" = o."org_id"
  AND s."name" = 'agent-instructions@' || o."name"
  AND s."type" = 'volume';--> statement-breakpoint
WITH orphan_agent_composes AS MATERIALIZED (
  SELECT c."id", c."org_id", c."name"
  FROM "agent_composes" c
  WHERE NOT EXISTS (
      SELECT 1 FROM "zero_agents" z
      WHERE z."id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "agent_compose_versions" v
      INNER JOIN "agent_runs" r
        ON r."agent_compose_version_id" = v."id"
      WHERE v."compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agent_sessions" s
      WHERE s."agent_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "chat_threads" t
      WHERE t."agent_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "email_thread_sessions" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "github_installations" i
      WHERE i."default_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "org_metadata" m
      WHERE m."default_agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "telegram_installations" i
      WHERE i."default_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "zero_agent_schedules" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "voice_chat_sessions" s
      WHERE s."agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "zero_runs" r
      WHERE r."trigger_agent_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agentphone_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "slack_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "telegram_user_agent_preferences" p
      WHERE p."selected_compose_id" = c."id"
    )
)
DELETE FROM "storages" s
USING orphan_agent_composes o
WHERE s."org_id" = o."org_id"
  AND s."name" = 'agent-instructions@' || o."name"
  AND s."type" = 'volume';--> statement-breakpoint
DELETE FROM "agent_composes" c
WHERE NOT EXISTS (
    SELECT 1 FROM "zero_agents" z
    WHERE z."id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "agent_compose_versions" v
    INNER JOIN "agent_runs" r
      ON r."agent_compose_version_id" = v."id"
    WHERE v."compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "agent_sessions" s
    WHERE s."agent_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "chat_threads" t
    WHERE t."agent_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "email_thread_sessions" s
    WHERE s."agent_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "github_installations" i
    WHERE i."default_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "org_metadata" m
    WHERE m."default_agent_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "telegram_installations" i
    WHERE i."default_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "zero_agent_schedules" s
    WHERE s."agent_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "voice_chat_sessions" s
    WHERE s."agent_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "zero_runs" r
    WHERE r."trigger_agent_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "agentphone_user_agent_preferences" p
    WHERE p."selected_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "slack_user_agent_preferences" p
    WHERE p."selected_compose_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "telegram_user_agent_preferences" p
    WHERE p."selected_compose_id" = c."id"
  );
