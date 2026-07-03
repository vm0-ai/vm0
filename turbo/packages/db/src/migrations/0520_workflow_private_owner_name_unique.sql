DO $$
DECLARE
  duplicate_workflow RECORD;
  attempt integer;
  candidate_name text;
  suffix text;
  base_name text;
BEGIN
  FOR duplicate_workflow IN
    SELECT
      id,
      org_id,
      agent_id,
      owner_user_id,
      name,
      replace(id::text, '-', '') AS id_fragment,
      row_number() OVER (
        PARTITION BY org_id, agent_id, owner_user_id, name
        ORDER BY created_at ASC, id ASC
      ) AS duplicate_rank
    FROM zero_workflows
    WHERE visibility = 'private'
  LOOP
    IF duplicate_workflow.duplicate_rank = 1 THEN
      CONTINUE;
    END IF;

    attempt := 0;
    LOOP
      IF attempt < 25 THEN
        suffix := '-dup-' || left(duplicate_workflow.id_fragment, 8 + attempt);
      ELSE
        suffix := '-dup-' || left(duplicate_workflow.id_fragment, 24) || '-' ||
          (attempt - 24)::text;
      END IF;

      base_name := regexp_replace(
        left(duplicate_workflow.name, 64 - char_length(suffix)),
        '-+$',
        ''
      );
      IF base_name = '' THEN
        base_name := 'wf';
      END IF;
      candidate_name := base_name || suffix;

      IF NOT EXISTS (
        SELECT 1
        FROM zero_workflows
        WHERE org_id = duplicate_workflow.org_id
          AND agent_id = duplicate_workflow.agent_id
          AND owner_user_id = duplicate_workflow.owner_user_id
          AND visibility = 'private'
          AND name = candidate_name
          AND id <> duplicate_workflow.id
      ) THEN
        UPDATE zero_workflows
        SET name = candidate_name
        WHERE id = duplicate_workflow.id;
        EXIT;
      END IF;

      attempt := attempt + 1;
      IF attempt > 40 THEN
        RAISE EXCEPTION
          'Failed to generate unique private workflow name for workflow %',
          duplicate_workflow.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;
