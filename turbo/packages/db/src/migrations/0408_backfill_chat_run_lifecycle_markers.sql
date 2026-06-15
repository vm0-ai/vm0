WITH terminal_chat_runs AS (
  SELECT
    zero_runs.chat_thread_id,
    agent_runs.id AS run_id,
    CASE
      WHEN agent_runs.status = 'completed' THEN 'completed'
      WHEN agent_runs.status = 'cancelled'
        OR LOWER(COALESCE(agent_runs.error, '')) = 'run cancelled'
        THEN 'cancelled'
      ELSE 'failed'
    END AS run_lifecycle_event,
    COALESCE(
      agent_runs.completed_at,
      agent_runs.started_at,
      agent_runs.created_at
    ) AS created_at
  FROM zero_runs
  JOIN agent_runs ON agent_runs.id = zero_runs.id
  WHERE zero_runs.chat_thread_id IS NOT NULL
    AND agent_runs.status IN ('completed', 'failed', 'cancelled', 'timeout')
    AND NOT EXISTS (
      SELECT 1
      FROM chat_messages existing_marker
      WHERE existing_marker.run_id = agent_runs.id
        AND existing_marker.run_lifecycle_event IS NOT NULL
    )
),
inserted_markers AS (
  INSERT INTO chat_messages (
    chat_thread_id,
    run_id,
    role,
    content,
    error,
    run_lifecycle_event,
    created_at
  )
  SELECT
    chat_thread_id,
    run_id,
    'assistant',
    NULL,
    NULL,
    run_lifecycle_event,
    created_at
  FROM terminal_chat_runs
  ON CONFLICT DO NOTHING
  RETURNING chat_thread_id, created_at
),
latest_inserted_marker AS (
  SELECT
    chat_thread_id,
    MAX(created_at) AS created_at
  FROM inserted_markers
  GROUP BY chat_thread_id
)
UPDATE chat_threads
SET last_message_at = GREATEST(
  chat_threads.last_message_at,
  latest_inserted_marker.created_at
)
FROM latest_inserted_marker
WHERE chat_threads.id = latest_inserted_marker.chat_thread_id;
