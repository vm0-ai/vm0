WITH eligible_usage AS (
  SELECT
    ue.run_id,
    zr.chat_thread_id,
    COALESCE(ar.completed_at, MAX(ue.processed_at), ar.created_at) AS run_finished_at,
    COALESCE(MAX(ue.processed_at), MAX(ue.created_at), ar.completed_at, ar.created_at) AS settled_at,
    COALESCE(SUM(COALESCE(ue.credits_charged, 0)) FILTER (WHERE ue.status = 'processed'), 0)::bigint AS total_credits,
    COUNT(*) FILTER (WHERE ue.status = 'processed') AS processed_count,
    COUNT(*) FILTER (WHERE ue.status = 'pending') AS pending_count
  FROM usage_event ue
  INNER JOIN agent_runs ar ON ar.id = ue.run_id
  INNER JOIN zero_runs zr ON zr.id = ue.run_id
  INNER JOIN chat_threads ct ON ct.id = zr.chat_thread_id
  WHERE ue.run_id IS NOT NULL
    AND ar.status IN ('completed', 'failed', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM chat_messages existing_usage_message
      WHERE existing_usage_message.run_id = ue.run_id
        AND existing_usage_message.usage_payload IS NOT NULL
    )
  GROUP BY ue.run_id, zr.chat_thread_id, ar.completed_at, ar.created_at
  HAVING COUNT(*) FILTER (WHERE ue.status = 'processed') > 0
     AND COUNT(*) FILTER (WHERE ue.status = 'pending') = 0
),
provider_totals AS (
  SELECT
    ue.run_id,
    ue.kind,
    COALESCE(NULLIF(ue.provider, ''), 'unknown') AS provider,
    GREATEST(0, COALESCE(SUM(COALESCE(ue.credits_charged, 0)), 0))::bigint AS credits
  FROM usage_event ue
  INNER JOIN eligible_usage eu ON eu.run_id = ue.run_id
  WHERE ue.status = 'processed'
  GROUP BY ue.run_id, ue.kind, COALESCE(NULLIF(ue.provider, ''), 'unknown')
),
kind_totals AS (
  SELECT
    run_id,
    kind,
    COALESCE(SUM(credits), 0)::bigint AS credits,
    jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'credits', credits
      )
      ORDER BY provider
    ) AS providers
  FROM provider_totals
  GROUP BY run_id, kind
),
usage_payloads AS (
  SELECT
    eu.run_id,
    eu.chat_thread_id,
    eu.run_finished_at,
    jsonb_build_object(
      'version', 1,
      'totalCredits', GREATEST(0, eu.total_credits),
      'settledAt', to_char(eu.settled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'breakdown', jsonb_agg(
        jsonb_build_object(
          'kind', kt.kind,
          'credits', kt.credits,
          'providers', kt.providers
        )
        ORDER BY kt.kind
      )
    ) AS usage_payload
  FROM eligible_usage eu
  INNER JOIN kind_totals kt ON kt.run_id = eu.run_id
  GROUP BY eu.run_id, eu.chat_thread_id, eu.run_finished_at, eu.total_credits, eu.settled_at
),
message_anchors AS (
  SELECT
    up.run_id,
    up.chat_thread_id,
    up.usage_payload,
    COALESCE(MAX(run_messages.created_at), up.run_finished_at) AS anchor_created_at
  FROM usage_payloads up
  LEFT JOIN chat_messages run_messages
    ON run_messages.run_id = up.run_id
   AND run_messages.usage_payload IS NULL
  GROUP BY up.run_id, up.chat_thread_id, up.usage_payload, up.run_finished_at
),
message_positions AS (
  SELECT
    ma.run_id,
    ma.chat_thread_id,
    ma.usage_payload,
    CASE
      WHEN next_message.next_created_at IS NULL THEN ma.anchor_created_at + INTERVAL '1 microsecond'
      WHEN next_message.next_created_at > ma.anchor_created_at + INTERVAL '1 microsecond'
        THEN ma.anchor_created_at + ((next_message.next_created_at - ma.anchor_created_at) / 2)
      ELSE ma.anchor_created_at + INTERVAL '1 microsecond'
    END AS created_at
  FROM message_anchors ma
  LEFT JOIN LATERAL (
    SELECT MIN(next_thread_message.created_at) AS next_created_at
    FROM chat_messages next_thread_message
    WHERE next_thread_message.chat_thread_id = ma.chat_thread_id
      AND next_thread_message.created_at > ma.anchor_created_at
  ) next_message ON true
)
INSERT INTO chat_messages (
  chat_thread_id,
  run_id,
  role,
  content,
  usage_payload,
  created_at
)
SELECT
  chat_thread_id,
  run_id,
  'assistant',
  NULL,
  usage_payload,
  created_at
FROM message_positions
ON CONFLICT (run_id) WHERE usage_payload IS NOT NULL DO NOTHING;
