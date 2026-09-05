# Database Migrations

Generate migrations with `pnpm -F @okouai/db db:generate` and verify them with
`pnpm -F @okouai/db test:migration-consistency`. Do not edit an existing migration
or snapshot after it has shipped.

Transactional migrations start with a `1s` `lock_timeout` and a `10s`
`statement_timeout`. A migration that needs more time may override either
default with a later `SET LOCAL` statement in that migration. Non-transactional
migrations do not receive these defaults and must manage their own timeout
requirements.

## Transition validators

A transition validator protects an expand → contract rollout while old and new
application versions and data shapes may coexist. Delete one only after all
three event-based conditions are satisfied:

1. Its target migration has shipped in a production release. Confirm that the
   production `__drizzle_migrations.created_at` is greater than or equal to the
   migration's `when` value in `src/migrations/meta/_journal.json`.
2. The expand → contract cycle it covers is complete. The contract migration is
   deployed, and no dual-write or dual-read compatibility window remains.
3. Every invariant it asserts that still applies to the current schema has been
   promoted to the permanent tier of the migration consistency suite.

There is no time-based retention window. Elapsed time does not determine whether
a transition validator still protects a live rollout. The squash line advances
to the last migration in the most recent production release. When that removes a
referenced migration tag from the journal, the consistency suite fails and the
expired transition validator must be deleted.

### Active transition validators

- `scripts/test-pi-memory-checkpoint-settlement.ts` protects migration
  `1079_pi_memory_checkpoint_settlement` (#31937): real PostgreSQL checks exact
  live legacy grandfathering, valid sandbox leases, unsafe-shape rollback and
  rejection of fresh null/null or mismatched claims from `1078_baseline`.
  Retire it only after the three transition conditions above are met; retain
  the current claim-shape invariants in permanent coverage.

## Migration patterns

The following patterns no longer have a surviving migration example, so keep
the complete SQL here.

### Run a batched backfill without blocking writers

Use the non-transactional marker so the procedure can commit each batch. Lock
only the selected rows, skip rows held by concurrent writers, and never take a
table lock. If the backfill temporarily relaxes a trigger function, restore its
accepted body byte-for-byte before the migration completes.

```sql
-- vm0:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "backfill_example"()
LANGUAGE plpgsql
AS $$
DECLARE
  affected_rows integer;
BEGIN
  LOOP
    WITH "batch" AS (
      SELECT "id"
      FROM "example_table"
      WHERE "canonical_value" IS NULL
      ORDER BY "id"
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "example_table" AS "target"
    SET "canonical_value" = "target"."legacy_value"
    FROM "batch"
    WHERE "target"."id" = "batch"."id";

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    COMMIT;
    EXIT WHEN affected_rows = 0;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_example"();
--> statement-breakpoint
DROP PROCEDURE "backfill_example"();
```

### Add and validate a constraint online

Add the constraint with `NOT VALID` so PostgreSQL enforces it for new writes
without first scanning all existing rows. Validate existing rows separately:

```sql
ALTER TABLE "child_table"
ADD CONSTRAINT "child_table_parent_id_parent_table_id_fk"
FOREIGN KEY ("parent_id") REFERENCES "parent_table" ("id")
NOT VALID;
--> statement-breakpoint
ALTER TABLE "child_table"
VALIDATE CONSTRAINT "child_table_parent_id_parent_table_id_fk";
```

### Create an index without blocking writes

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so the migration
must use the non-transactional marker:

```sql
-- vm0:non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS "table_created_at_idx"
ON "table" ("created_at");
```

## Permanent triggers and functions

When a migration adds a trigger or function, update
`EXPECTED_PERMANENT_TRIGGERS` or `EXPECTED_PERMANENT_FUNCTIONS` in
`scripts/test-migration-consistency-schema.ts` in the same change. Trigger keys
include the complete `pg_get_triggerdef` output, and function keys include the
MD5 of the function body. Changing trigger timing, the function it executes, an
`UPDATE OF` column list, or a function body therefore makes the permanent
inventory test fail until the expected inventory is updated.
