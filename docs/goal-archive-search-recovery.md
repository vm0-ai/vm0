# Completed Goal search recovery (2026-09-09)

**Status: completed and independently accepted. Dispatch instructions are retired.**
The temporary execution entry from #32875 / #32978 is removed by
[S3 #33023](https://github.com/vm0-ai/vm0/issues/33023). This dated record preserves
its evidence and historical design; it does not authorize another dispatch,
replay, retry, production approval or release. The sole recovery operator has
stopped, and the controller deleted its separate Okou watcher and verified absence.

**Subsequent S5 acceptance, 2026-09-10:**
[independent production verification](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780)
accepted the contracted schema from Ethan's successful #33307
(`9c777819776d2bed0cfdb110653e46dcaffc0e8b`), separately from #33253's DDL
`40P01` failure. The accepted actual production 1106 DDL → helper cleanup/reset
→ awaited journal INSERT → `Migrations complete` path at **17:21:49.5878347 UTC**
and fresh physical metadata establish completion. No direct journal/catalog
SELECT is claimed; MaskDB does not expose those rows. See
[the recorded migration gates](../turbo/packages/db/MIGRATIONS.md#retired-goal-transition-validators-2026-09-10).
The pre-contract SQL/procedures below are historical and no longer apply to the
current schema. The numbered 014 README/code/exports remain unchanged; do not
replay the completed operation.

## Final operation and acceptance

The sole successful apply was
[run 34356992223 / job 102484085578](https://github.com/vm0-ai/vm0/actions/runs/34356992223/job/102484085578),
attempt **1**, mode **apply**, source
`aba3bd9692db398472b6033432d802f94d0579cc`. The job succeeded at
**2026-09-09 15:38:53 UTC**. The
[operator's complete certificate](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5604617146)
and [independent controller acceptance](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5604844349)
retain the exact ten source/run/attempt-bound records and production observations.
The controller accepted S2 at **2026-09-09 15:59:18.802907 UTC**.

| Complete phase           | Processed | Unchanged | Repairable | Repaired | Not indexed / deleted / revoked |
| ------------------------ | --------: | --------: | ---------: | -------: | ------------------------------- |
| Preflight                |     4,162 |     4,158 |          4 |        0 | 0 / 0 / 0                       |
| Apply                    |     4,162 |     4,158 |          0 |        4 | 0 / 0 / 0                       |
| Fresh final verification |     4,162 |     4,162 |          0 |        0 | 0 / 0 / 0                       |

The four repaired results are **thread outcomes**, not a separately measured
number of document writes. Before, immediately before apply, and after final
verification, all **three complete cohorts** retained 4,162 Goals, 4,162 distinct
threads and 4,162 complete receipts; 3,819 complete / 143 paused / 200 blocked /
active 0; actual Goal-origin nonterminal runs 0 and unrevoked runless Goal inputs
including reservations 0. Every full ID hash remained
`aa033d67b27ff3fdbd30c945e482962b3e054cf4a1a4f74fce7edf74fed4e7f2`.
Fresh final verification completed at **15:38:49.4093750 UTC**, followed by the
after cohort at **15:38:50.8156683 UTC** and complete record at
**15:38:50.8159048 UTC**.

The complete workflow inventory contained four terminal operations: successful
dry-runs [34329154556](https://github.com/vm0-ai/vm0/actions/runs/34329154556)
and [34350816813](https://github.com/vm0-ai/vm0/actions/runs/34350816813), cancelled
apply [34333317500](https://github.com/vm0-ai/vm0/actions/runs/34333317500), and the
successful apply above. No active or queued operation remained. The cancelled
apply's attributable commit count remains **UNKNOWN**; it cannot be inferred by
subtracting four from the earlier nine repairable findings.

Only receipt-addressed derived search documents were repaired. Original
objectives/status archives, raw history, snapshots, immutable public shares and
search watermarks were retained. S2 acceptance does not authorize S4 consumer
removal or S5 physical schema cleanup without their separate gates.

## Retired execution sources

All deleted sources remain available at accepted commit
[`30c84e22f32fb43bfc12af672fa1aec9a8969c47`](https://github.com/vm0-ai/vm0/commit/30c84e22f32fb43bfc12af672fa1aec9a8969c47):

- [Temporary GitHub workflow](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/.github/workflows/temporary-goal-archive-search-recovery.yml).
- [Dedicated workflow fixture](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/.github/scripts/tests/goal-archive-search-recovery-workflow-test.sh).
- [Execution wrapper](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/turbo/packages/db/scripts/goal-archive-search-recovery/run.ts).
- [Certificate validator](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/turbo/packages/db/scripts/goal-archive-search-recovery/certificate.ts).
- [Dedicated certificate tests](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/turbo/packages/db/scripts/goal-archive-search-recovery/certificate.test.ts).

The historical design below describes that accepted source. The original numbered
[014 operation](../turbo/packages/db/scripts/migrations/014-goal-archive-search/README.md)
and shipped SQL/snapshots/journal remain under repository migration policy.
S5 removed physical receipts; S6a retires the expired validators and pre-contract
API fixture branches while retaining current-schema history coverage. No
execution or scheduling authority is added to history readers.

## Historical serving and convergence prerequisite

Before each historical dispatch, the sole recovery owner, chat
`cacc99f2-1570-4e64-961c-40b3fe8db2cf`, recorded normal API serving identity and
outgoing normal projector completion/convergence evidence in the EPIC. The gate
required repaired readers and S1 creation/reactivation and continuation fences
to remain effective, without creating a Goal canary. Release records or elapsed
time alone did not establish that prerequisite.

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

These normal-production prerequisites were rechecked before execution. The
workflow had no extra operator-assertion or source inputs. Its production
approval and the controller's evidence ledger owned this prerequisite; the
workflow did not independently prove live serving identity. Historical
Vercel/fixed-deployment inventory is outside the
[user-approved scope](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5595137042).
Cron 200 or elapsed time never substitutes for the full data certificate below;
`not-indexed > 0` requires normal projector convergence and investigation.

## Historical dispatch and source guards

The original invocation examples are retained only in the
[immutable accepted guide](https://github.com/vm0-ai/vm0/blob/30c84e22f32fb43bfc12af672fa1aec9a8969c47/docs/goal-archive-search-recovery.md#exact-invocation).
The workflow and wrapper are deleted; these examples are not current operating
instructions. No further dispatch is expected or authorized by this record.

Only `workflow_dispatch` on `refs/heads/main` reached the finite 240-minute protected
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

Implementation and controller acceptance required execution of the workflow's actual
`Validate mode and accepted operation source` shell step against real Git history
at the exact reviewed HEAD, with `GITHUB_SHA` set to that HEAD, for both modes.
This check needs all three ancestor commits locally and no production credentials.
The full SHA and byte/ancestry results were recorded alongside the executable
workflow fixture's independent missing-ancestor, changed-path, invalid-mode and
dispatch-SHA rejection results. Shallow-checkout synthetic fixtures alone cannot
prove that the reviewed source matches either accepted baseline. Before each
historical production approval, the operator revalidated the actual dispatched
main source and accepted execution files if main had advanced.

The resolver reuses existing `NEON_API_KEY`, the expected
`NEON_PROJECT_ID=hidden-lab-39609750`, and a unique `production` branch. It rejects
partial branch listings, redirects and invalid URIs, requires the expected DB/role
and Neon host, enforces `sslmode=verify-full`, and masks the URI before transferring
it inside the protected job. Existing R2 account/bucket variables and access
secrets are mounted only for execution. There is no credential export, new secret
store or sandbox credential requirement.

## Historical certificate and output

The retired wrapper and certificate validator are linked to their immutable
accepted sources above.
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

## Historical job budget and operator continuation (#32978)

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
or after cohort was emitted. The committed repair count is **UNKNOWN**; nine
repairable threads do not mean nine repaired threads or zero committed repairs.

Apply requires three complete scans: fresh preflight, full apply and fresh full
verification. Three scans at 58m39s take **175m57s**, about 176 minutes before
setup/cohort reads. The finite **240-minute** budget adds about **64 minutes**
for setup and timing variability; the earlier standalone dry-run took about
41m15s. This is a measured allocation, not a completion guarantee. Preserve all
three scans, the full cohort and all existing transaction, lock, statement,
object-request and inventory bounds. There is no operator timeout override.

The GitHub job could outlive an operator's **two-hour assistant run**. At that
boundary, the historical continuation procedure required an EPIC checkpoint:

1. Exact run and job URLs/IDs, attempt, dispatched full source SHA, mode,
   observation UTC, actual job/check status and approval state.
2. Only completed source/run/attempt-bound phase reports and count/hash records;
   identify the last started phase and every absent report. The wrapper captures
   child output until a complete phase validates, so a quiet active phase does
   not expose a committed repair count.
3. The assistant stopped with the GitHub job intact. Controller
   `9faa0333-002f-418a-b47d-185aa32afa4a` continued the same sole operator,
   `cacc99f2-1570-4e64-961c-40b3fe8db2cf`, to observe the same run/job and attempt.
   Crossing the assistant boundary did not permit another dispatch, rerun,
   cancellation or executor. This completed owner is now stopped.

Assistant continuation was not a GitHub retry or a completion certificate.
After #32978 was merged and independently accepted, the existing operator
rechecked the terminal two-run inventory (dry-run `34329154556`, apply
`34333317500`), the actual accepted dispatch source and current normal
serving/projector prerequisites. The new full dry-run and successful apply
reported above then completed all fresh scans; prior reports did not replace
them. Safe per-thread commits from the cancelled apply remained, with their
attributable count still UNKNOWN.

## Historical failure handling and completed disposal

Each apply thread commits independently. Failure rolls back its current
transaction; earlier safe committed repairs remain. A clear can legitimately
delete a Goal receipt while retaining ordinary archive history. A count/hash
change before, during or after the run stops certification. Operation failure
also attempts a fresh metadata-only count/hash diagnostic, without rerunning
the operation. If that read fails, the sanitized error says so; there is no
certificate. Cancellation/timeout may prevent a final diagnostic or summary.

The historical failure procedure returned source/run identity, phase, observed
counts/hash and sanitized error class to the controller. It prohibited Goal
reconstruction, cohort shrinking, watermark resets, raw-history changes,
fabricated terminal success and blind apply retries. A prior report or resumed
subset was never write authority or a completion certificate; the historical
014 README's low-level cursor example did not apply to this protected path.

Independent S2 production acceptance closed the disposal gate. S3 #33023 removed
the five temporary workflow/wrapper/dedicated-test files linked above before
S5 subsequently dropped receipt inventory. The separate Okou S2 watcher was
already deleted and its absence verified by the controller. This record and its immutable source,
run and controller links remain; no recovery workflow is expected to run again.
The numbered 014 operation, its original README/code/package exports and shipped
1093/1094/1105/1106 SQL, journal and snapshots remain unchanged. S6a removes the
expired transition validation after accepted S5 contraction. Permanent history,
accounting and security contracts, S1 and combined-S4 rollback floors and shared
DB dependencies remain; official resource and durable instruction disposition
are still controller-owned.
