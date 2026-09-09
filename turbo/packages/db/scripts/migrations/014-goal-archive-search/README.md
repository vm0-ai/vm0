# 014: Restore literal Goal archive search documents

Issue #32834 repairs readable projections of the immutable 1094 notice. An old
API can have stripped citation-shaped objective text, written the search document,
and advanced its watermark before this API is promoted. Updating the reader does
not recover that derived text. This one-off operation repairs only receipt-addressed
archive documents whose watermark already covers the archive. It does not reindex
other messages, reset watermarks, read objectives from `thread_goals`, or change
raw events, snapshots, public shares, Goal state, or lifecycle behavior.

## Release gate and execution

The implementation owner stops at PR merge. The EPIC #32653 controller must
independently accept #32813 and #32834 and delegate production work to its separate
release-only owner. That owner runs this operation after the repaired API is serving
and the outgoing search-projector invocations have completed, before accepting S2.
If 1094 shipped earlier, the same operation repairs that earlier exposure. Do not
execute a production command as part of implementation or local verification.

Use the canonical candidate containing both changes, with dependencies installed,
1093/1094 applied and the receipt columns still present. The receipt is only the
bounded repair inventory; ordinary readers never consult it and continue to work
after S5 drops Goal state. Complete and verify this operation before S5.

Required environment: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_USER_STORAGES_BUCKET_NAME`. Use the existing
authorized database/object-storage credentials; never place credentials in CLI
arguments. Object storage is read-only. No content is written to files or reports.

Run from `turbo/packages/db`:

```bash
# Default dry-run uses read-only SQL transactions and reports counts only.
pnpm exec tsx scripts/migrations/014-goal-archive-search/backfill.ts

# Explicitly authorized execution. Each thread commits independently.
pnpm exec tsx scripts/migrations/014-goal-archive-search/backfill.ts --migrate

# Resume a bounded/failed operation at its last reported completed page.
pnpm exec tsx scripts/migrations/014-goal-archive-search/backfill.ts \
  --migrate --max-threads 100 --after-thread '<last-completed-thread-uuid>'
```

A run processes at most 5,000 receipt threads (100 per candidate page), sufficient
for the measured 4,162-Goal cohort. `--max-threads` can reduce this bound. SQL uses
a 1-second lock timeout and a 10-second statement timeout. Repeatable-read history
combines the validated checksum/order/terminal metadata of schema-7 snapshots with
paged PostgreSQL tails. Missing/corrupt archives, incorrect provenance, and projection
ownership mismatches fail without printing SQL, provider errors, or objective text.
A retry may revisit the previous page; matching text/bigram documents are unchanged.
A concurrently changed row causes a transaction failure rather than a stale rewrite.

Only an archive whose full provenance, content-only payload, exact 1094 grammar,
receipt ID and sequence agree can repair a document. Existing revokers retain their
visibility authority. Current thread/agent ownership is checked, and an apply
transaction locks those parents against concurrent deletion. Missing unindexed
archives remain the normal projector's responsibility. Search result ownership and
retention rules remain unchanged.

A complete **fresh** dry-run after execution must report zero `repairable`, no
errors, and `complete: true`; a resumed partial scan is not a full certificate.
`not-indexed` requires normal projector convergence followed by another fresh
verification. `revoked` records intentional invisibility; investigate any unexpected
count privately. The old projector uses conflict-do-nothing inserts, so it cannot
overwrite repaired text; waiting for its outgoing invocations also closes the
not-yet-indexed window. No arbitrary waiting period replaces that serving/convergence
evidence. Reports contain counts and opaque resume coordinates only.

## Public shares

Existing shares are immutable selected copies. This operation never changes or
republishes them. New hot/snapshot shares and reads of intact saved archive text
preserve literals. An already-stripped public copy cannot recover absent text from
its own stored representation; only its owner can explicitly create a new share.
No affected production share inventory was queried or inferred for this repair.

## Verification

`goal-retirement-history.test.ts` executes unchanged 1094 against real PostgreSQL,
checks all four recorded statuses through history/search/share APIs, installs the
old API's stripped projection and advanced watermark, snapshots and removes covered
hot events, and runs this recovery in dry-run/apply/retry modes. It verifies repaired
search results, unchanged old shares, new snapshot shares, exact export, and ordinary
manual continuation through production endpoints. Shared contract tests cover strict
provenance, the complete frozen grammar and literal delimiter variants. The regular
API PR pipeline runs the regression; this script adds no persistent endpoint or job.
