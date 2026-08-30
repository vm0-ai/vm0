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

The repository inventory below is machine-checked. The removal owner must
delete the workflow, probe, focused validator, and this entry together.

| Issue                             | Validator                                                   | Removal owner   |
| --------------------------------- | ----------------------------------------------------------- | --------------- |
| #27613 / #27656 / #27671 / #27792 | Agent/Compose consolidation production preflight            | #26938 Stage 8  |
| #27896                            | Legacy execution-plan preflight classifier                  | #26938 Stage 8  |
| #27997                            | Framework-fallback preflight partition                      | #26938 Stage 8  |
| #28056                            | Historical product-builder preflight fixture and classifier | #26938 Stage 8  |
| #28056                            | Historical product-builder preflight partition              | #26938 Stage 8  |
| #28070                            | Historical builder v6 authority-lineage partition           | #26938 Stage 8  |
| #28080                            | Checkpoint configuration-independence manifest              | #26938 Stage 8  |
| #28080                            | Checkpoint v7 protected partition                           | #26938 Stage 8  |
| #28304                            | Usage-pack pending snapshot dirty upgrade                   | #28372          |
| #28795                            | Official Slack installation Okou brand finalization         | #28937          |
| #29378 / #29429                   | Agent Draft relation compatibility and physical switch      | #28368 Phase D3 |
| #29910                            | Built-in provider writer/backfill and rollback bridge       | #28368          |
| #30162                            | Built-in model restriction entitlement expand/mirror bridge | #28368          |

<!-- vm0-transition-validator:#27613+#27656+#27671+#27792|agent-compose-consolidation-preflight|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#27896|legacy-execution-plan-preflight-classifier|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#27997|framework-fallback-preflight-partition|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28056|historical-product-builder-preflight-fixture-and-classifier|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28056|historical-product-builder-preflight-partition|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28070|historical-product-builder-v6-authority-lineage-partition|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28080|checkpoint-configuration-independence-runtime-manifest|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28080|checkpoint-v7-protected-partition|removal-owner:#26938-stage-8 -->
<!-- vm0-transition-validator:#28304|usage-pack-pending-snapshot-dirty-upgrade|removal-owner:#28372 -->
<!-- vm0-transition-validator:#28795|official-slack-installation-okou-brand-finalization|removal-owner:#28937 -->
<!-- vm0-transition-validator:#29378+#29429|agent-draft-relation-compatibility-and-physical-switch|removal-owner:#28368-phase-d3 -->
<!-- vm0-transition-validator:#29910|built-in-provider-writer-backfill-and-rollback-bridge|removal-owner:#28368 -->
<!-- vm0-transition-validator:#30162|built-in-model-restriction-entitlement-expand-mirror-bridge|removal-owner:#28368 -->

## Migration patterns

[`0811_clear_non_goal_run_groups.sql`](./src/migrations/0811_clear_non_goal_run_groups.sql)
is the only surviving example of an online backfill migration. It demonstrates:

- the `-- vm0:non-transactional` marker;
- narrowly relaxing the append-only trigger function and restoring its original
  body byte-for-byte in the same migration; and
- batching with `FOR UPDATE ... SKIP LOCKED` and explicit `COMMIT`, without
  taking a `LOCK TABLE`.

The following patterns no longer have a surviving migration example, so keep the
complete SQL here.

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
