WITH thread_model_candidates AS (
  -- Prefer the latest historical run model when the thread can be tied to one.
  SELECT
    cm.chat_thread_id,
    zr.selected_model,
    0 AS priority,
    cm.created_at AS source_created_at,
    cm.id AS source_id
  FROM "chat_messages" cm
  INNER JOIN "zero_runs" zr ON zr.id = cm.run_id
  INNER JOIN "chat_threads" ct ON ct.id = cm.chat_thread_id
  WHERE ct.selected_model IS NULL
    AND zr.selected_model IS NOT NULL
  UNION ALL
  SELECT
    zr.chat_thread_id,
    zr.selected_model,
    0 AS priority,
    ar.created_at AS source_created_at,
    zr.id AS source_id
  FROM "zero_runs" zr
  INNER JOIN "agent_runs" ar ON ar.id = zr.id
  INNER JOIN "chat_threads" ct ON ct.id = zr.chat_thread_id
  WHERE ct.selected_model IS NULL
    AND zr.selected_model IS NOT NULL
  UNION ALL
  -- Fall back to the workspace default only when no run model is available.
  SELECT
    ct.id AS chat_thread_id,
    omp.model AS selected_model,
    1 AS priority,
    ct.created_at AS source_created_at,
    ct.id AS source_id
  FROM "chat_threads" ct
  INNER JOIN "agent_composes" ac ON ac.id = ct.agent_compose_id
  INNER JOIN "org_model_policies" omp ON omp.org_id = ac.org_id
  WHERE ct.selected_model IS NULL
    AND omp.is_default = true
  UNION ALL
  -- Final fallback for legacy threads whose org has no default policy row.
  SELECT
    ct.id AS chat_thread_id,
    'MiniMax-M3' AS selected_model,
    2 AS priority,
    ct.created_at AS source_created_at,
    ct.id AS source_id
  FROM "chat_threads" ct
  WHERE ct.selected_model IS NULL
),
ranked_thread_models AS (
  SELECT
    chat_thread_id,
    selected_model,
    row_number() OVER (
      PARTITION BY chat_thread_id
      ORDER BY priority ASC, source_created_at DESC, source_id DESC
    ) AS rn
  FROM thread_model_candidates
),
backfilled AS (
  UPDATE "chat_threads" ct
  SET "selected_model" = r.selected_model
  FROM ranked_thread_models r
  WHERE r.rn = 1
    AND ct.id = r.chat_thread_id
    AND ct.selected_model IS NULL
  RETURNING
    ct.id,
    ct.user_id,
    ct.agent_compose_id,
    ct.selected_model
)
INSERT INTO "chat_thread_events" (
  "user_id",
  "org_id",
  "chat_thread_id",
  "kind",
  "agent_compose_id",
  "title",
  "selected_model",
  "created_at"
)
SELECT
  b.user_id,
  ac.org_id,
  b.id,
  'model_selection_updated'::chat_thread_event_kind,
  b.agent_compose_id,
  NULL,
  b.selected_model,
  NOW()
FROM backfilled b
INNER JOIN "agent_composes" ac ON ac.id = b.agent_compose_id
WHERE NOT EXISTS (
  SELECT 1
  FROM "chat_thread_events" existing
  WHERE existing.chat_thread_id = b.id
    AND existing.kind = 'model_selection_updated'::chat_thread_event_kind
    AND existing.selected_model = b.selected_model
);
