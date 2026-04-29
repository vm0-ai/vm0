# Backfill credit_usage to usage_event

Issue: #11501
Parent cleanup: #11497

This is a manual, one-off data migration script. It does not run during deploy,
does not call billing processors, and does not deduct org credits. It only
adds processed `usage_event` rows that mirror already processed legacy
`credit_usage` rows.

## What It Migrates

Source rows:

```sql
credit_usage.status = 'processed'
AND credit_usage.processed_at IS NOT NULL
AND at least one model-token column is positive
```

Token mapping:

| `credit_usage` column         | `usage_event.category`  |
| ----------------------------- | ----------------------- |
| `input_tokens`                | `tokens.input`          |
| `output_tokens`               | `tokens.output`         |
| `cache_read_input_tokens`     | `tokens.cache_read`     |
| `cache_creation_input_tokens` | `tokens.cache_creation` |

Target rows are inserted with:

- `kind = 'model'`
- `provider = credit_usage.model`
- `status = 'processed'`
- original `org_id`, `user_id`, `run_id`, `created_at`, and `processed_at`

`web_search_requests` is not migrated because the legacy credit processor did
not charge it.

## Credits

If `credit_usage.credits_charged` is `NULL`, every generated
`usage_event.credits_charged` is also `NULL`.

If `credits_charged` is non-null:

1. The script first tries to reconstruct per-category credits from current
   `credit_pricing` using the legacy formula:
   `ceil(tokens * price / 1_000_000)`.
2. If that split sums to the source row's `credits_charged`, the script uses
   it.
3. If pricing is missing or no longer matches the historical source total, the
   script reports a warning and falls back to deterministic token-quantity
   allocation.

For every migrated source row with non-null credits, the invariant is:

```text
sum(backfilled usage_event.credits_charged) == credit_usage.credits_charged
```

## Idempotency

The script uses deterministic UUIDv5 idempotency keys.

- Rows with both `run_id` and `message_id` use the same
  `(run_id, message_id, category)` shape as the current model usage producer so
  rollout overlaps are detected.
- Older rows without `message_id`, and rows whose `run_id` was cleared by
  `ON DELETE SET NULL`, use a backfill-specific identity shape based on
  `credit_usage.id`, optional `run_id`, optional `message_id`, optional
  `result_uuid`, and category.
- Inserts use `ON CONFLICT DO NOTHING`, so the script is safe to rerun.

## Usage

Run from `turbo/apps/web`.

Dry-run:

```bash
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts
```

Write:

```bash
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --migrate
```

Useful scoped runs:

```bash
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --org-id=org_xxx
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --limit=100
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --batch-size=250
```

Treat warnings as fatal:

```bash
dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --fail-on-anomaly
```

## Preflight SQL

Pending legacy rows:

```sql
SELECT count(*)
FROM credit_usage
WHERE status = 'pending';
```

Processed source rows:

```sql
SELECT count(*)
FROM credit_usage
WHERE status = 'processed'
  AND processed_at IS NOT NULL;
```

Historical row shapes:

```sql
SELECT
  count(*) FILTER (WHERE message_id IS NOT NULL) AS with_message_id,
  count(*) FILTER (WHERE message_id IS NULL AND result_uuid IS NOT NULL) AS with_result_uuid,
  count(*) FILTER (WHERE message_id IS NULL AND result_uuid IS NULL) AS with_neither
FROM credit_usage
WHERE status = 'processed'
  AND processed_at IS NOT NULL;
```

Rows requiring attention:

```sql
SELECT
  count(*) FILTER (WHERE run_id IS NULL) AS null_run_id,
  count(*) FILTER (WHERE length(model) > 100) AS provider_too_long,
  count(*) FILTER (WHERE credits_charged IS NULL) AS null_credits_charged,
  count(*) FILTER (
    WHERE input_tokens < 0
       OR output_tokens < 0
       OR cache_read_input_tokens < 0
       OR cache_creation_input_tokens < 0
  ) AS negative_tokens
FROM credit_usage
WHERE status = 'processed'
  AND processed_at IS NOT NULL;
```

## Verification

The script summary is the primary verification surface. Before writing, it
validates the planned rows against existing `usage_event` idempotency keys and
checks that every source row with non-null `credits_charged` preserves its
known credit total.

The SQL below is only safe when scoped to a controlled org/time window where
you know the selected `usage_event` rows are the backfilled rows. A production
full-table comparison can be misleading because `usage_event` also contains
post-rollout model usage that never existed in `credit_usage`.

```sql
WITH legacy AS (
  SELECT COALESCE(sum(credits_charged), 0) AS credits
  FROM credit_usage
  WHERE status = 'processed'
    AND processed_at IS NOT NULL
    AND (
      input_tokens > 0
      OR output_tokens > 0
      OR cache_read_input_tokens > 0
      OR cache_creation_input_tokens > 0
    )
),
events AS (
  SELECT COALESCE(sum(credits_charged), 0) AS credits
  FROM usage_event
  WHERE status = 'processed'
    AND kind = 'model'
    AND category IN (
      'tokens.input',
      'tokens.output',
      'tokens.cache_read',
      'tokens.cache_creation'
    )
)
SELECT legacy.credits AS legacy_credits, events.credits AS event_credits
FROM legacy, events;
```

Token parity by category under the same controlled scope:

```sql
WITH legacy AS (
  SELECT 'tokens.input' AS category, COALESCE(sum(input_tokens), 0) AS quantity FROM credit_usage WHERE status = 'processed' AND processed_at IS NOT NULL
  UNION ALL
  SELECT 'tokens.output', COALESCE(sum(output_tokens), 0) FROM credit_usage WHERE status = 'processed' AND processed_at IS NOT NULL
  UNION ALL
  SELECT 'tokens.cache_read', COALESCE(sum(cache_read_input_tokens), 0) FROM credit_usage WHERE status = 'processed' AND processed_at IS NOT NULL
  UNION ALL
  SELECT 'tokens.cache_creation', COALESCE(sum(cache_creation_input_tokens), 0) FROM credit_usage WHERE status = 'processed' AND processed_at IS NOT NULL
),
events AS (
  SELECT category, COALESCE(sum(quantity), 0) AS quantity
  FROM usage_event
  WHERE status = 'processed'
    AND kind = 'model'
    AND category IN (
      'tokens.input',
      'tokens.output',
      'tokens.cache_read',
      'tokens.cache_creation'
    )
  GROUP BY category
)
SELECT
  legacy.category,
  legacy.quantity AS legacy_quantity,
  COALESCE(events.quantity, 0) AS event_quantity
FROM legacy
LEFT JOIN events ON events.category = legacy.category
ORDER BY legacy.category;
```

## Rollback

This migration is additive. Before #11497 removes dual-ledger reads, rollback
means deleting only the `usage_event` rows created by this script. Do not use
broad filters such as `kind = 'model'`; those will include normal post-rollout
usage events.

If rollback is needed, derive the exact idempotency-key set from the same source
selection and helper logic used by the script, review the key list, and delete
only those keys in a controlled operator session. Do not delete rows with
idempotency keys that existed before this migration.
