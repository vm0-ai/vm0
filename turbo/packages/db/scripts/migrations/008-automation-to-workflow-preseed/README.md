# 008 — Automation → workflow migration: SKILL.md volume preseed

Companion data migration for the automation → workflow cutover
(issue [vm0-ai/vm0#19959](https://github.com/vm0-ai/vm0/issues/19959)).
This is **PR-1** of the two-PR delivery: it ships the
`automations.migrated_to_workflow_id` provenance column (SQL migration
`0532_automation_migrated_to_workflow`) and this preseed script. Merging and
running it changes no production behavior.

## Background

The cutover SQL migration (PR-2) creates, per `automations` row:

- a private `zero_workflows` row **reusing the automation's id**,
- a `zero_workflow_triggers` schedule row carrying the legacy schedule/state,
- a `workflow_user_trigger_threads` row reusing the legacy chat thread,

and freezes the legacy rows (trigger `enabled = false`, `nextRunAt` kept).

What SQL cannot do is create the workflow's skill volume — an R2 object pair
(`archive.tar.gz` + `manifest.json`) plus `storages` / `storage_versions`
rows, named `custom-skill@{workflowId}`. The runtime **silently skips**
missing skill volumes, so a migrated trigger firing before its volume exists
would produce a run whose `/slug` prompt has no skill mounted. The volume must
therefore exist before cutover.

Because the workflow id equals the automation id, the volume name is
predictable ahead of the cutover: this script uploads
`custom-skill@{automation.id}` for every automation. Until PR-2's migration
runs, these volumes are unreferenced and inert.

## What the script does

For every `automations` row (optionally filtered by `--org`):

1. Synthesize SKILL.md via `synthesizeWorkflowSkillMd` from:
   - **name**: slug-normalized automation name (`wf-{first 8 id chars}`
     fallback when the normalized result is shorter than 2 chars) — must match
     the name PR-2's SQL writes on the workflow row;
   - **description**: the automation description;
   - **instruction**: the automation instruction, with a non-blank
     `append_system_prompt` appended under an `## Additional instructions`
     heading.
2. Upsert the `storages` row (`custom-skill@{automation.id}`, org volume) and
   compute the content-hash version id. If the head version already matches,
   the row is reported `up-to-date` and nothing is written.
3. Otherwise upload `archive.tar.gz` + `manifest.json` and insert the
   `storage_versions` row / advance the head — mirroring the server-side
   volume upload (`storage-volume-upload.service.ts`).

The script is **idempotent** (version ids are content hashes) and defaults to
**dry-run**; it only mutates when `--migrate` is passed. Re-running after an
automation was edited uploads a new head version.

## Prerequisites

Same environment as 007 (mirrors `apps/api/src/signals/external/s3.ts`):

| Variable                       | Required | Notes                                     |
| ------------------------------ | -------- | ----------------------------------------- |
| `DATABASE_URL`                 | yes      | Postgres connection string                |
| `R2_USER_STORAGES_BUCKET_NAME` | yes      | Workflow volume bucket                    |
| `R2_ACCOUNT_ID`                | yes\*    | \*not needed if `S3_ENDPOINT` is set      |
| `R2_ACCESS_KEY_ID`             | yes      | R2 access key                             |
| `R2_SECRET_ACCESS_KEY`         | yes      | R2 secret key                             |
| `S3_ENDPOINT`                  | no       | Overrides the default R2 account endpoint |
| `S3_REGION`                    | no       | Defaults to `auto`                        |
| `S3_FORCE_PATH_STYLE`          | no       | `"true"` / `"false"`                      |

## Usage

From `turbo/packages/db`:

```bash
# 1. Dry-run: report what would be created/updated, write nothing.
pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts

# 2. Execute.
pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts --migrate

# Single org (staging rehearsal / spot checks)
pnpm exec tsx scripts/migrations/008-automation-to-workflow-preseed/preseed.ts --migrate --org=org_xxx
```

Run schedule relative to the PR-2 cutover release:

1. **Any time before the release** — bulk of the work; re-runnable.
2. **Right before the release** — sync rows created/edited since step 1.
3. **After the release** — final sweep. The cutover blocks all legacy mutating
   API routes, so nothing new can appear after this run. (PR-2 also adds the
   `nextRunAt` croner-repair for triggers that were mid-run at cutover; see
   the issue.)

## Verification

After a `--migrate` run, every automation has a head-versioned volume:

```sql
SELECT a.id
FROM automations a
LEFT JOIN storages s
  ON s.org_id = a.org_id
 AND s.user_id = '__org__'
 AND s.type = 'volume'
 AND s.name = 'custom-skill@' || a.id
WHERE s.head_version_id IS NULL;
-- expect: 0 rows
```
