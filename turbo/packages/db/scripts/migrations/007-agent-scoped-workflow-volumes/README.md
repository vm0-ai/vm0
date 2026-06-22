# 007 — Agent-scoped workflow volume re-key + instruction backfill

Companion data migration for SQL migration `0479_agent_scoped_workflows`
(issue [vm0-ai/vm0#18434](https://github.com/vm0-ai/vm0/issues/18434)).

## Background

The SQL migration already transformed the database:

- every `zero_workflows` row now has an `agent_id`;
- multi-bound workflows were duplicated into one row per agent (new uuids, but
  the **same** `name`);
- true-orphan workflows were deleted;
- `zero_workflow_agents` was dropped.

What SQL could **not** do (it needs object-storage I/O) is the R2 volume work
and the `instruction` backfill. That is what this script does.

A workflow's files live in an org-scoped storage "volume": a `storages` row
(`orgId`, `userId = VOLUME_ORG_USER_ID`, `name`, `type='volume'`,
`headVersionId`, `s3Prefix`) plus `storage_versions` (`s3Key`) and S3/R2 objects
under the prefix. Historically the volume name was
`getCustomSkillStorageName(workflowName)` = `custom-skill@{name}`. The new code
keys volumes by **workflow id**: `getCustomSkillStorageName(workflowId)` =
`custom-skill@{id}`.

## What the script does

For each org that owns workflows (or a single `--org`), in order:

1. **Re-key volumes to workflow id.** For every current `zero_workflows` row,
   ensure a volume named `custom-skill@{id}` exists. When it does not, the
   content is copied from the legacy `custom-skill@{name}` volume into a fresh,
   id-scoped `s3Prefix` (`{orgId}/volume/custom-skill@{id}`): the `storages` row
   and every `storage_versions` row are recreated and each version's S3 objects
   (`archive.tar.gz`, `manifest.json`) are copied under the new key. Because
   duplicated rows share a `name`, **each id-keyed row gets its own copy** and
   never shares an `s3Prefix`. Always copies (never renames in place) so the
   legacy volume stays intact for the other duplicates.

2. **Backfill `instruction`.** For each workflow whose `instruction` is `null`,
   reads `SKILL.md` from the id-keyed volume's head version archive, runs
   `extractInstructionFromSkillMd` (from `@vm0/core`), and writes the body back
   to `zero_workflows.instruction`. Empty bodies / missing SKILL.md are left
   `null`.

3. **Delete legacy name-keyed volumes.** After all workflows in an org have
   been re-keyed, deletes every leftover `custom-skill@*` volume that is not a
   current id-keyed volume and is not being preserved because its workflow could
   not be safely re-keyed in this run (storages row + versions via FK cascade +
   S3 objects).

The script is **idempotent** and **defaults to dry-run**. It only mutates when
`--migrate` is passed. Re-running detects already-id-keyed volumes and
already-backfilled instructions and skips them.

## Prerequisites

Environment variables:

| Variable                       | Required | Notes                                            |
| ------------------------------ | -------- | ------------------------------------------------ |
| `DATABASE_URL`                 | yes      | Postgres connection string                       |
| `R2_USER_STORAGES_BUCKET_NAME` | yes      | Workflow volume bucket                           |
| `R2_ACCOUNT_ID`                | yes\*    | \*not needed if `S3_ENDPOINT` is set             |
| `R2_ACCESS_KEY_ID`             | yes      | R2 access key                                    |
| `R2_SECRET_ACCESS_KEY`         | yes      | R2 secret key                                    |
| `S3_ENDPOINT`                  | no       | Overrides the default R2 account endpoint        |
| `S3_REGION`                    | no       | Defaults to `auto`                               |
| `S3_FORCE_PATH_STYLE`          | no       | `"true"` / `"false"`                             |

These mirror the S3/R2 client construction in
`apps/api/src/signals/external/s3.ts`.

## Usage

From `turbo/packages/db`:

```bash
# Dry run (default) — prints the plan with counts, makes no changes
pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts

# Execute for all orgs that own workflows
pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --migrate

# Execute for a single org
pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --migrate --org=org_xxx
```

## Verification

After a `--migrate` run:

1. **Every workflow has an id-keyed volume.**

   ```sql
   SELECT w.id
   FROM zero_workflows w
   LEFT JOIN storages s
     ON s.org_id = w.org_id
    AND s.user_id = '__org__'
    AND s.type = 'volume'
    AND s.name = 'custom-skill@' || w.id::text
   WHERE s.id IS NULL;
   -- expect 0 rows (workflows missing an id-keyed volume)
   ```

2. **Instructions backfilled where a SKILL.md existed.**

   ```sql
   SELECT count(*) FROM zero_workflows WHERE instruction IS NULL AND type = 'workflow';
   -- residual nulls = goals or workflows whose SKILL.md body was empty/missing
   ```

3. **No leftover legacy name-keyed volumes.** Confirm remaining `custom-skill@*`
   volumes are all id-keyed (name matches an existing `zero_workflows.id`):

   ```sql
   SELECT s.name
   FROM storages s
   WHERE s.user_id = '__org__' AND s.type = 'volume'
     AND s.name LIKE 'custom-skill@%'
     AND NOT EXISTS (
       SELECT 1 FROM zero_workflows w
       WHERE 'custom-skill@' || w.id::text = s.name
     );
   -- expect 0 rows
   ```

4. **No id-keyed volumes share an `s3Prefix`** (duplicated rows got their own
   copy):

   ```sql
   SELECT s3_prefix, count(*)
   FROM storages
   WHERE user_id = '__org__' AND type = 'volume' AND name LIKE 'custom-skill@%'
   GROUP BY s3_prefix HAVING count(*) > 1;
   -- expect 0 rows
   ```

## Notes

- **Idempotent**: safe to re-run; already-migrated volumes/instructions are
  skipped.
- **Excluded from CI**: like all `scripts/migrations/**`, this directory is
  excluded from the package `tsconfig.json` (`exclude`) and `eslint.config.mjs`
  (`ignores`), so it does not participate in the `@vm0/db` build, type-check, or
  lint.
- **Permanent record**: per the database-development convention, this script
  must not be deleted even after the migration is complete.
