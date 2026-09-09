# Temporary protected Goal search recovery (#32875)

This is the production execution entry for the accepted, unchanged operation
[014](../turbo/packages/db/scripts/migrations/014-goal-archive-search/README.md),
under [EPIC #32653](https://github.com/vm0-ai/vm0/issues/32653). It repairs only
receipt-addressed derived search documents. It does not change Goal lifecycle,
1093/1094, raw history, snapshots, immutable public shares or search watermarks.

The implementation owner stops at protected merge. The controller independently
accepts the merged workflow and negative gates, then delegates execution to the
existing sole recovery owner, chat `cacc99f2-1570-4e64-961c-40b3fe8db2cf`. Only that
owner dispatches and handles actual `production` environment approvals. A merged
entry is usable from `main` after controller acceptance; no API/App release is
needed for this workflow. Its merge is not S2 production acceptance.

## Serving and convergence prerequisite

Before **each dispatch**, the recovery owner records current normal API serving
identity and outgoing normal projector completion/convergence evidence in the
EPIC. Verify the repaired reader remains serving and the S1 creation/reactivation
and continuation fences remain effective. Do not create a Goal canary. A release
record or the passage of time alone is insufficient if serving has changed.

The actual accepted starting evidence is the
[release owner's report](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5597708442):

- Release #32841, merge `82d1a6ff154c9ca81fd8e08d6764290733eb324d`,
  [workflow 34320369826](https://github.com/vm0-ai/vm0/actions/runs/34320369826),
  all 21 jobs successful; API 1.575.0 and App 0.871.0. Normal API promotion
  completed at **2026-09-09 07:00:03.2195524 UTC**. Runtime schema identity also
  names that API version, SHA and workflow.
- A non-partial Axiom read covering **05:37:16.9253904–07:03:09.885577 UTC**
  accounted for 86 normal projector requests in 86 consecutive minute buckets,
  all completed with HTTP 200. The final outgoing invocation completed at
  **06:59:42.956 UTC**, before promotion. Repaired invocations starting at
  07:00:41.309, 07:01:41.376 and 07:02:41.437 also completed. The route awaits
  projection transactions/convergence before its completion log; the unchanged
  old writer uses conflict-do-nothing inserts and cannot overwrite a repair.
- Full metadata census at **07:03:09.882275–07:03:12.951423 UTC** still matched
  all original 4,162 IDs, with 3,819 complete / 143 paused / 200 blocked.
  Actual Goal-origin queued/pending/running was zero without a time filter.
  These are publication-time observations, not recovery results.

Recheck and record these normal-production prerequisites before execution. The
workflow deliberately has no extra operator-assertion or source inputs. Its
production approval and the controller's evidence ledger own this prerequisite;
the workflow does not independently prove live serving identity. Historical
Vercel/fixed-deployment inventory is outside the
[user-approved scope](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5595137042).
Cron 200 or elapsed time never substitutes for the full data certificate below;
`not-indexed > 0` requires normal projector convergence and investigation.

## Exact invocation

From an authorized GitHub CLI session, after controller acceptance:

```bash
# Default/read-only preflight (mode can be omitted; its default is dry-run).
gh workflow run temporary-goal-archive-search-recovery.yml \
  --repo vm0-ai/vm0 --ref main -f mode=dry-run

# Independently repeats preflight in the same job before any mutation.
gh workflow run temporary-goal-archive-search-recovery.yml \
  --repo vm0-ai/vm0 --ref main -f mode=apply
```

Use the returned GitHub run identity and its job summary as evidence. Only
`workflow_dispatch` on `refs/heads/main` reaches the finite 240-minute protected
job. Both modes share one concurrency group with cancellation disabled. No push,
PR, release, schedule, arbitrary SQL, command, ref, bucket, cursor, count or hash
override is available. Checkout uses the dispatched `github.sha`, with credentials
not persisted. Before binding production secrets, the job validates the mode,
accepted merge ancestry and unchanged engine/import source, then installs frozen
DB dependencies with install scripts disabled. Actions are pinned to full SHAs.

### Exact accepted source

The original archive merge `3e1544d55ac0dc54a1cdb21d6aee72d651a6808d` and repair
merge `cede9cbfb62872ddabb705de852dc6fd81a3cc6d` must remain ancestors of the
dispatched source. Every guarded path in the 014 engine/import closure and
1093/1094 retains exact byte comparison to the repair merge, except one file:
`turbo/packages/api-contracts/src/contracts/pi-memory-citations.ts` is compared
only to reviewed branding merge `04531239c7e796799f1dca20ab36f7af1d075f85`
([#32891](https://github.com/vm0-ai/vm0/pull/32891)), which must also be an ancestor.
The single accepted difference is line 7's license comment, `vm0` to `Okou`.
No runtime logic changed. Any further difference, including another comment
edit, must fail before production secrets are bound. Do not advance the whole
closure to a newer main, ignore comments, omit paths or add a source override.

Implementation and controller acceptance must execute the workflow's actual
`Validate mode and accepted operation source` shell step against real Git history
at the exact reviewed HEAD, with `GITHUB_SHA` set to that HEAD, for both modes.
This check needs all three ancestor commits locally and no production credentials.
Record that full SHA and the byte/ancestry results alongside the executable
workflow fixture's independent missing-ancestor, changed-path, invalid-mode and
dispatch-SHA rejection results. Shallow-checkout synthetic fixtures alone cannot
prove that the reviewed source matches either accepted baseline. Before each
production approval, the operator validates the actual dispatched main source
and accepted execution files again if main has advanced.

The resolver reuses existing `NEON_API_KEY`, the expected
`NEON_PROJECT_ID=hidden-lab-39609750`, and a unique `production` branch. It rejects
partial branch listings, redirects and invalid URIs, requires the expected DB/role
and Neon host, enforces `sslmode=verify-full`, and masks the URI before transferring
it inside the protected job. Existing R2 account/bucket variables and access
secrets are mounted only for execution. There is no credential export, new secret
store or sandbox credential requirement.

## Certificate and output

The small wrapper lives at
[`scripts/goal-archive-search-recovery/run.ts`](../turbo/packages/db/scripts/goal-archive-search-recovery/run.ts),
with the validation boundary in
[`certificate.ts`](../turbo/packages/db/scripts/goal-archive-search-recovery/certificate.ts).
Every invocation starts at the full inventory. A metadata-only, read-only SQL
snapshot computes the complete ID hash, unique-thread count, complete receipts,
statuses, actual Goal-origin nonterminal runs and unrevoked runless Goal inputs
(including reservations). It does not select objective or snapshot content.

Required fixed certificate:

- Goals, distinct threads and complete receipts: **4,162 each**.
- Status: **3,819 complete / 143 paused / 200 blocked / active 0**.
- Actual `trigger_source='goal'` queued/pending/running: **0**, without a date
  or `goal_id` filter. Unrevoked runless `input.goal`, including reserved: **0**.
- SHA256 of UTF-8 `"\n".join(sorted(ids)) + "\n"`:
  `aa033d67b27ff3fdbd30c945e482962b3e054cf4a1a4f74fce7edf74fed4e7f2`.
  PostgreSQL orders canonical UUID text with the C collation and includes the
  trailing LF. No receipt filter can silently remove an ID from this census.

`dry-run` validates the cohort, runs the default 014 dry-run, then rechecks the
cohort. The final report must have processed **4,162**, `complete: true`, exact
known fields, nonnegative integer counts summing to processed, and zero
not-indexed/deleted/revoked/repaired. `repairable > 0` is a successful **preflight
finding**, not completed recovery.

`apply` repeats its own fresh cohort and dry-run preflight, rechecks the cohort
immediately before mutation, calls only 014 with `--migrate`, validates the entire
apply report, runs a new full default dry-run, then rechecks the cohort. Apply
requires repairable/not-indexed/deleted/revoked zero; final dry-run additionally
requires repaired zero. Every phase requires consistent totals and the complete
4,162 inventory. Earlier progress, child exit 0, an empty/smaller inventory,
malformed/trailing output, stderr, missing final LF or an incomplete final report
cannot establish success.

Logs and the job summary retain only sanitized mode/phase, count/hash,
completion/error class and exact source/run/attempt identity. The child's raw
stdout/stderr is captured with a 1 MiB output cap and never echoed. No secret,
provider/SQL error text, objective, snapshot or raw query artifact is retained.
Per-phase `complete` describes that report only; recovery certification requires
the successful **apply job**, its final verification and `after` cohort check,
plus controller acceptance. A successful standalone dry-run can still report work.

014 retains its 5,000-thread inventory ceiling, 100-thread candidate pages,
1,000-event tail pages, one-second locks, ten-second statements and 30-second
object request timeout. Its existing snapshot decompression/history accumulation
is unchanged. The workflow timeout bounds the job; it is **not a per-thread
memory bound**.

## Measured job budget and operator continuation (#32978)

The first apply [run 34333317500 / job 102406764659](https://github.com/vm0-ai/vm0/actions/runs/34333317500/job/102406764659),
attempt 1, dispatched source `99bd2254849a4890c0bf7dc12c151b6463b34726`, was
cancelled by GitHub at **2026-09-09 10:42:30 UTC**. Its annotation states
`The job has exceeded the maximum execution time of 1h30m0s`. The
[terminal evidence](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5600632181)
contains a complete preflight from **09:13:00 to 10:11:39 UTC** (**58m39s**):
4,162 processed, 4,153 unchanged, nine repairable and all other outcomes zero.
Both before and immediately-before-apply cohorts matched all 4,162 Goals,
distinct threads and complete receipts, the fixed hash and every prerequisite.
Apply started **10:11:41 UTC**. No complete apply report, fresh final verification
or after cohort was emitted. The committed repair count is **unknown**; nine
repairable threads do not mean nine repaired threads or zero committed repairs.

Apply requires three complete scans: fresh preflight, full apply and fresh full
verification. Three scans at 58m39s take **175m57s**, about 176 minutes before
setup/cohort reads. The finite **240-minute** budget adds about **64 minutes**
for setup and timing variability; the earlier standalone dry-run took about
41m15s. This is a measured allocation, not a completion guarantee. Preserve all
three scans, the full cohort and all existing transaction, lock, statement,
object-request and inventory bounds. There is no operator timeout override.

A GitHub job can outlive an operator's **two-hour assistant run**. Before that
assistant limit, the sole operator records a continuation checkpoint on the EPIC:

1. Exact run and job URLs/IDs, attempt, dispatched full source SHA, mode,
   observation UTC, actual job/check status and approval state.
2. Only completed source/run/attempt-bound phase reports and count/hash records;
   identify the last started phase and every absent report. The wrapper captures
   child output until a complete phase validates, so a quiet active phase does
   not expose a committed repair count.
3. Stop the assistant run while leaving the GitHub job intact. Controller
   `9faa0333-002f-418a-b47d-185aa32afa4a` continues the same sole operator,
   `cacc99f2-1570-4e64-961c-40b3fe8db2cf`, to read the same run/job and attempt.
   Resume observation of that job whether it is still active or became terminal
   between assistant runs. Do not dispatch, rerun, cancel or add an executor to
   cross the assistant runtime boundary.

An assistant continuation is not a GitHub retry or a completion certificate.
If the GitHub job actually times out or fails again, preserve safe per-thread
commits, report only observed counts and missing evidence, and return to the
controller before any retry. After this repair is merged and independently
accepted, the existing operator first rechecks the terminal two-run inventory
(dry-run `34329154556`, apply `34333317500`), the actual accepted dispatch source
and current normal serving/projector prerequisites, then follows the full fresh
dry-run and apply certification path. Prior reports never replace these scans.

## Failure, partial commits and disposal

Each apply thread commits independently. Failure rolls back its current
transaction; earlier safe committed repairs remain. A clear can legitimately
delete a Goal receipt while retaining ordinary archive history. A count/hash
change before, during or after the run stops certification. Operation failure
also attempts a fresh metadata-only count/hash diagnostic, without rerunning
the operation. If that read fails, the sanitized error says so; there is no
certificate. Cancellation/timeout may prevent a final diagnostic or summary.

Return the source/run identity, phase, observed counts/hash and sanitized error
class to the controller. Never reconstruct Goals, shrink the cohort, reset a
watermark, alter raw history, fabricate terminal success or retry apply blindly.
The controller reconciles intentional deletion or commissions a separately
bounded canonical-inventory repair. Only after the actual blocker is resolved
may the owner rerun this same full entry; already-correct documents remain
unchanged. A prior run's report or a resumed subset is never write authority or
a completion certificate. The historical 014 README's low-level cursor example
does not apply to this protected certification path.

After successful recovery and independent S2 production acceptance, the
controller assigns the next S3/S4 consumer-removal owner to delete the temporary
workflow, wrapper and their dedicated tests. This must happen **before S5 drops
receipt inventory**. Keep this dated operational record, the original numbered
014 operation and immutable 1093/1094 history under repository migration policy.
Retain the actual run and controller evidence on the EPIC before disposal.
