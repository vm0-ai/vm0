DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_run_callbacks"
    WHERE "internal_kind" IN (
      'workflow-automation:cron',
      'workflow-automation:loop'
    )
      AND "payload" ? 'automationId'
      AND "payload" ? 'triggerId'
      AND "payload" -> 'automationId' IS DISTINCT FROM "payload" -> 'triggerId'
  ) THEN
    RAISE EXCEPTION 'workflow automation callback identifiers disagree';
  END IF;

  UPDATE "agent_run_callbacks"
  SET "payload" =
    ("payload" - 'triggerId') ||
    jsonb_build_object(
      'automationId',
      CASE
        WHEN "payload" ? 'automationId' THEN "payload" -> 'automationId'
        ELSE "payload" -> 'triggerId'
      END
    )
  WHERE "internal_kind" IN (
    'workflow-automation:cron',
    'workflow-automation:loop'
  )
    AND "payload" ? 'triggerId';
END $$;
