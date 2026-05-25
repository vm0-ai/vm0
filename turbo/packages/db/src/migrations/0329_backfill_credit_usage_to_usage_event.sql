-- Backfill processed legacy credit_usage model-token rows into usage_event.
--
-- This is intentionally an additive data migration:
-- - only processed legacy rows are copied
-- - target rows are inserted as already processed
-- - no credit processors run and no org credits are deducted
--
-- Tests may set vm0.credit_usage_backfill_org_id in the migration session to
-- re-run this exact body against one isolated org. Production leaves it unset.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_credit_usage_backfill_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('vm0.credit_usage_backfill_org_id', true), '')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_uuid_name(parts text[])
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result bytea := ''::bytea;
  part text;
  part_bytes bytea;
  part_count int := COALESCE(array_length(parts, 1), 0);
  idx int := 0;
BEGIN
  FOREACH part IN ARRAY parts LOOP
    IF part IS NULL THEN
      RAISE EXCEPTION 'uuid name parts must not be null';
    END IF;

    idx := idx + 1;
    part_bytes := convert_to(part, 'UTF8');
    result := result
      || convert_to(octet_length(part_bytes)::text || ':', 'UTF8')
      || part_bytes;

    IF idx < part_count THEN
      result := result || decode('00', 'hex');
    END IF;
  END LOOP;

  RETURN result;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_uuid_v5(namespace_uuid uuid, name_bytes bytea)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  namespace_bytes bytea := decode(replace(namespace_uuid::text, '-', ''), 'hex');
  hash_bytes bytea;
  hash_hex text;
BEGIN
  hash_bytes := substring(digest(namespace_bytes || name_bytes, 'sha1') from 1 for 16);

  -- UUID version 5 and RFC 4122 variant bits.
  hash_bytes := set_byte(hash_bytes, 6, (get_byte(hash_bytes, 6) & 15) | 80);
  hash_bytes := set_byte(hash_bytes, 8, (get_byte(hash_bytes, 8) & 63) | 128);

  hash_hex := encode(hash_bytes, 'hex');
  RETURN (
    substring(hash_hex from 1 for 8) || '-' ||
    substring(hash_hex from 9 for 4) || '-' ||
    substring(hash_hex from 13 for 4) || '-' ||
    substring(hash_hex from 17 for 4) || '-' ||
    substring(hash_hex from 21 for 12)
  )::uuid;
END
$$;
--> statement-breakpoint

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM credit_usage cu
  WHERE cu.status = 'processed'
    AND cu.processed_at IS NOT NULL
    AND (
      pg_temp.vm0_credit_usage_backfill_org_id() IS NULL
      OR cu.org_id = pg_temp.vm0_credit_usage_backfill_org_id()
    )
    AND (
      cu.input_tokens < 0
      OR cu.output_tokens < 0
      OR cu.cache_read_input_tokens < 0
      OR cu.cache_creation_input_tokens < 0
    );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill found % processed rows with negative token quantities', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM credit_usage cu
  WHERE cu.status = 'processed'
    AND cu.processed_at IS NOT NULL
    AND (
      pg_temp.vm0_credit_usage_backfill_org_id() IS NULL
      OR cu.org_id = pg_temp.vm0_credit_usage_backfill_org_id()
    )
    AND cu.credits_charged < 0;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill found % processed rows with negative credits_charged', invalid_count;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS pg_temp.vm0_credit_usage_backfill_plan;
--> statement-breakpoint

CREATE TEMP TABLE vm0_credit_usage_backfill_plan ON COMMIT DROP AS
WITH source_rows AS (
  SELECT
    cu.id AS source_id,
    cu.run_id,
    cu.result_uuid,
    cu.message_id,
    cu.org_id,
    cu.user_id,
    cu.model AS provider,
    cu.model_provider,
    cu.input_tokens,
    cu.output_tokens,
    cu.cache_read_input_tokens,
    cu.cache_creation_input_tokens,
    cu.credits_charged AS source_credits_charged,
    cu.created_at,
    cu.processed_at,
    (
      (cu.input_tokens > 0)::int
      + (cu.output_tokens > 0)::int
      + (cu.cache_read_input_tokens > 0)::int
      + (cu.cache_creation_input_tokens > 0)::int
    ) AS positive_category_count
  FROM credit_usage cu
  WHERE cu.status = 'processed'
    AND cu.processed_at IS NOT NULL
    AND (
      pg_temp.vm0_credit_usage_backfill_org_id() IS NULL
      OR cu.org_id = pg_temp.vm0_credit_usage_backfill_org_id()
    )
    AND (
      cu.input_tokens > 0
      OR cu.output_tokens > 0
      OR cu.cache_read_input_tokens > 0
      OR cu.cache_creation_input_tokens > 0
    )
),
expanded AS (
  SELECT
    source_rows.source_id,
    source_rows.run_id,
    source_rows.result_uuid,
    source_rows.message_id,
    source_rows.org_id,
    source_rows.user_id,
    source_rows.provider,
    source_rows.model_provider,
    source_rows.source_credits_charged,
    source_rows.created_at,
    source_rows.processed_at,
    source_rows.positive_category_count,
    token.category,
    token.category_order,
    token.quantity,
    token.token_price
  FROM source_rows
  LEFT JOIN credit_pricing cp
    ON cp.model = source_rows.provider
    AND cp.model_provider = source_rows.model_provider
  CROSS JOIN LATERAL (
    VALUES
      ('tokens.input'::text, 1, source_rows.input_tokens, cp.input_token_price),
      ('tokens.output'::text, 2, source_rows.output_tokens, cp.output_token_price),
      ('tokens.cache_read'::text, 3, source_rows.cache_read_input_tokens, cp.cache_read_token_price),
      ('tokens.cache_creation'::text, 4, source_rows.cache_creation_input_tokens, cp.cache_creation_token_price)
  ) AS token(category, category_order, quantity, token_price)
  WHERE token.quantity > 0
),
priced AS (
  SELECT
    expanded.*,
    CASE
      WHEN expanded.token_price IS NULL THEN NULL
      ELSE ceil(expanded.quantity::numeric * expanded.token_price::numeric / 1000000)::bigint
    END AS pricing_credits,
    sum(expanded.quantity) OVER (PARTITION BY expanded.source_id) AS total_quantity
  FROM expanded
),
priced_totals AS (
  SELECT
    priced.*,
    sum(priced.pricing_credits) OVER (PARTITION BY priced.source_id) AS pricing_total,
    count(priced.pricing_credits) OVER (PARTITION BY priced.source_id) AS pricing_category_count
  FROM priced
),
fallback_base AS (
  SELECT
    priced_totals.*,
    CASE
      WHEN priced_totals.source_credits_charged IS NULL THEN NULL
      ELSE floor(
        priced_totals.source_credits_charged::numeric
        * priced_totals.quantity::numeric
        / priced_totals.total_quantity::numeric
      )::bigint
    END AS fallback_floor,
    CASE
      WHEN priced_totals.source_credits_charged IS NULL THEN NULL
      ELSE mod(
        priced_totals.source_credits_charged::numeric
        * priced_totals.quantity::numeric,
        priced_totals.total_quantity::numeric
      )
    END AS fallback_remainder_numerator
  FROM priced_totals
),
fallback_ranked AS (
  SELECT
    fallback_base.*,
    sum(fallback_base.fallback_floor) OVER (PARTITION BY fallback_base.source_id) AS fallback_floor_total,
    row_number() OVER (
      PARTITION BY fallback_base.source_id
      ORDER BY fallback_base.fallback_remainder_numerator DESC NULLS LAST, fallback_base.category_order ASC
    ) AS fallback_remainder_rank
  FROM fallback_base
),
final_rows AS (
  SELECT
    fallback_ranked.source_id,
    fallback_ranked.run_id,
    fallback_ranked.result_uuid,
    fallback_ranked.message_id,
    fallback_ranked.org_id,
    fallback_ranked.user_id,
    fallback_ranked.provider,
    fallback_ranked.model_provider,
    fallback_ranked.category,
    fallback_ranked.category_order,
    fallback_ranked.quantity,
    fallback_ranked.source_credits_charged,
    fallback_ranked.created_at,
    fallback_ranked.processed_at,
    CASE
      WHEN fallback_ranked.source_credits_charged IS NULL THEN NULL
      WHEN fallback_ranked.positive_category_count = 1 THEN fallback_ranked.source_credits_charged
      WHEN fallback_ranked.pricing_category_count = fallback_ranked.positive_category_count
        AND fallback_ranked.pricing_total = fallback_ranked.source_credits_charged
      THEN fallback_ranked.pricing_credits
      ELSE fallback_ranked.fallback_floor
        + CASE
            WHEN fallback_ranked.fallback_remainder_rank <= (
              fallback_ranked.source_credits_charged - fallback_ranked.fallback_floor_total
            )
            THEN 1
            ELSE 0
          END
    END AS credits_charged
  FROM fallback_ranked
)
SELECT
  final_rows.source_id,
  final_rows.run_id,
  final_rows.result_uuid,
  final_rows.message_id,
  final_rows.org_id,
  final_rows.user_id,
  'model'::varchar(30) AS kind,
  final_rows.provider,
  final_rows.model_provider,
  final_rows.category,
  final_rows.category_order,
  final_rows.quantity,
  final_rows.source_credits_charged,
  final_rows.credits_charged,
  'processed'::varchar(20) AS status,
  NULL::varchar(50) AS billing_error,
  final_rows.created_at,
  final_rows.processed_at,
  pg_temp.vm0_uuid_v5(
    '18a22204-d25e-4170-8973-86477f864bfb'::uuid,
    CASE
      WHEN final_rows.run_id IS NOT NULL AND final_rows.message_id IS NOT NULL THEN
        pg_temp.vm0_uuid_name(ARRAY[
          final_rows.run_id::text,
          final_rows.message_id,
          final_rows.category
        ])
      ELSE
        pg_temp.vm0_uuid_name(ARRAY[
          'credit-usage-backfill:v1',
          final_rows.source_id::text,
          COALESCE(final_rows.run_id::text, '<null-run-id>'),
          COALESCE(final_rows.message_id, '<null-message-id>'),
          COALESCE(final_rows.result_uuid::text, '<null-result-uuid>'),
          final_rows.category
        ])
    END
  ) AS idempotency_key
FROM final_rows;
--> statement-breakpoint

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM pg_temp.vm0_credit_usage_backfill_plan
  WHERE length(provider) > 100;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill found % rows whose model exceeds usage_event.provider length', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM pg_temp.vm0_credit_usage_backfill_plan
  WHERE quantity <= 0;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill planned % rows with non-positive quantity', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM (
    SELECT idempotency_key
    FROM pg_temp.vm0_credit_usage_backfill_plan
    GROUP BY idempotency_key
    HAVING count(*) > 1
  ) duplicates;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill planned % duplicate idempotency keys', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM (
    SELECT source_id
    FROM pg_temp.vm0_credit_usage_backfill_plan
    WHERE source_credits_charged IS NOT NULL
    GROUP BY source_id, source_credits_charged
    HAVING sum(credits_charged) IS DISTINCT FROM source_credits_charged
  ) mismatched_sources;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill failed credit parity for % source rows', invalid_count;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  conflict_count bigint;
BEGIN
  SELECT count(*) INTO conflict_count
  FROM pg_temp.vm0_credit_usage_backfill_plan p
  JOIN usage_event ue ON ue.idempotency_key = p.idempotency_key
  WHERE ue.run_id IS DISTINCT FROM p.run_id
    OR ue.org_id IS DISTINCT FROM p.org_id
    OR ue.user_id IS DISTINCT FROM p.user_id
    OR ue.kind IS DISTINCT FROM p.kind
    OR ue.provider IS DISTINCT FROM p.provider
    OR ue.category IS DISTINCT FROM p.category
    OR ue.quantity IS DISTINCT FROM p.quantity
    OR ue.credits_charged IS DISTINCT FROM p.credits_charged
    OR ue.status IS DISTINCT FROM p.status
    OR ue.billing_error IS DISTINCT FROM p.billing_error
    OR ue.created_at IS DISTINCT FROM p.created_at
    OR ue.processed_at IS DISTINCT FROM p.processed_at;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill found % existing usage_event rows with mismatched payloads', conflict_count;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  planned_count bigint;
  inserted_count bigint;
  existing_count bigint;
BEGIN
  SELECT count(*) INTO planned_count
  FROM pg_temp.vm0_credit_usage_backfill_plan;

  WITH inserted AS (
    INSERT INTO usage_event (
      run_id,
      idempotency_key,
      org_id,
      user_id,
      kind,
      provider,
      category,
      quantity,
      credits_charged,
      status,
      billing_error,
      created_at,
      processed_at
    )
    SELECT
      p.run_id,
      p.idempotency_key,
      p.org_id,
      p.user_id,
      p.kind,
      p.provider,
      p.category,
      p.quantity,
      p.credits_charged,
      p.status,
      p.billing_error,
      p.created_at,
      p.processed_at
    FROM pg_temp.vm0_credit_usage_backfill_plan p
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count
  FROM inserted;

  SELECT count(*) INTO existing_count
  FROM pg_temp.vm0_credit_usage_backfill_plan p
  JOIN usage_event ue ON ue.idempotency_key = p.idempotency_key;

  RAISE NOTICE 'credit_usage -> usage_event backfill planned %, inserted %, existing %',
    planned_count,
    inserted_count,
    existing_count - inserted_count;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  conflict_count bigint;
BEGIN
  SELECT count(*) INTO conflict_count
  FROM pg_temp.vm0_credit_usage_backfill_plan p
  JOIN usage_event ue ON ue.idempotency_key = p.idempotency_key
  WHERE ue.run_id IS DISTINCT FROM p.run_id
    OR ue.org_id IS DISTINCT FROM p.org_id
    OR ue.user_id IS DISTINCT FROM p.user_id
    OR ue.kind IS DISTINCT FROM p.kind
    OR ue.provider IS DISTINCT FROM p.provider
    OR ue.category IS DISTINCT FROM p.category
    OR ue.quantity IS DISTINCT FROM p.quantity
    OR ue.credits_charged IS DISTINCT FROM p.credits_charged
    OR ue.status IS DISTINCT FROM p.status
    OR ue.billing_error IS DISTINCT FROM p.billing_error
    OR ue.created_at IS DISTINCT FROM p.created_at
    OR ue.processed_at IS DISTINCT FROM p.processed_at;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'credit_usage -> usage_event backfill found % mismatched usage_event rows after insert', conflict_count;
  END IF;
END $$;
