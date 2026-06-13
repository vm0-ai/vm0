DROP INDEX IF EXISTS "chat_messages_usage_run_id_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_usage_run_id_idx" ON "chat_messages" USING btree ("run_id") WHERE "chat_messages"."usage_payload" IS NOT NULL;--> statement-breakpoint
WITH eligible_usage AS (
  SELECT
    ue.run_id,
    zr.chat_thread_id,
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
    eu.settled_at,
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
  GROUP BY eu.run_id, eu.chat_thread_id, eu.total_credits, eu.settled_at
),
latest_usage_messages AS (
  SELECT DISTINCT ON (cm.run_id)
    cm.run_id,
    cm.created_at,
    cm.usage_payload
  FROM chat_messages cm
  WHERE cm.usage_payload IS NOT NULL
  ORDER BY cm.run_id, cm.created_at DESC, cm.id DESC
),
stale_usage_payloads AS (
  SELECT
    up.run_id,
    up.chat_thread_id,
    up.settled_at,
    up.usage_payload,
    lum.created_at AS latest_usage_created_at
  FROM usage_payloads up
  INNER JOIN latest_usage_messages lum ON lum.run_id = up.run_id
  WHERE (lum.usage_payload->>'totalCredits')::bigint IS DISTINCT FROM (up.usage_payload->>'totalCredits')::bigint
     OR lum.usage_payload->'breakdown' IS DISTINCT FROM up.usage_payload->'breakdown'
),
message_positions AS (
  SELECT
    sup.run_id,
    sup.chat_thread_id,
    sup.usage_payload,
    CASE
      WHEN sup.settled_at > sup.latest_usage_created_at + INTERVAL '1 microsecond'
        THEN sup.settled_at
      ELSE sup.latest_usage_created_at + INTERVAL '1 microsecond'
    END AS created_at
  FROM stale_usage_payloads sup
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
FROM message_positions;
