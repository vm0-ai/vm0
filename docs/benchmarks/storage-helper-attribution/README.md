# Storage helper invocation attribution

Decision record for [#32428](https://github.com/vm0-ai/vm0/issues/32428), a child
of [#24203](https://github.com/vm0-ai/vm0/issues/24203). Measured September 8, 2026.
This change adds an experiment record and opt-in reproduction artifacts only.
It does not change Runner, guest code, containment, resource policy, or CI execution.

## Decision

The large residual is reproducible on the **first helper invocation after
resume**, not as a constant cost on every invocation. In the refined diagnostic
cohort, `Command::spawn()` took **9.188–24.815 ms** on nine first-after-resume
observations; command preparation took **6–7 microseconds**. Repeated calls in
that same cohort had spawn p90 of **1.831–1.970 ms** in each 300-call trial.
The enclosing cgroup creation and cleanup intervals were much smaller.

Do not weaken workload containment, remove mandatory storage work, introduce a
daemon, or change cancellation polling based on the production residual. No
safe optimization with a demonstrated gain is selected by this attribution PR.
The next useful target is the **cold/resumed spawn interval**, including its
child-side security hooks and exec handshake. The measurement does not separate
fork/clone, page faults, cgroup placement, identity syscalls, exec, and scheduling
inside that interval. Balloon-driven cache reclamation is a hypothesis, not a
proven cause. Changing balloon policy or replacing the launcher requires a
separate experiment and design review, including memory and isolation costs.

The provisional 5-ms p90 screen is not met by any single measured warm phase
across all trials. Cold spawn exceeds that scale, but these small cold cohorts
do not establish a stable p90 or a safely recoverable saving. This closes the
attribution/decision slice, not the parent performance effort or a runtime fix.

## Boundaries

| Observation                                              | Includes                                                                                                                                            | Excludes / interpretation                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production `runner_storage_manifest_guest_storage_apply` | `download_storages`: serialization, runtime-path construction, dedicated operation or fallback, result checks                                       | Prior cache population/staging and other spawn phases                                                                                                                           |
| Probe `outer_us`                                         | Manifest serialization, the same public Sandbox operation and await; fallback includes remove/write/exec                                            | Synthetic reconstruction, **not the production metric**: no production context/path construction, logging, or failure-cleanup wrapper; result validation occurs after the timer |
| Dedicated result `guest_ms`                              | Guest `run_manifest`, from before cancellation/cgroup creation through child handling, containment cleanup, input/output joins, and result assembly | Request parsing, worker admission/dispatch, response encoding, writer-lock wait and socket write                                                                                |
| Child `download_total`                                   | Input read, stale manifest cleanup, parsing, storage work, normalization                                                                            | Runtime log-path setup and argument parsing before the timer; final telemetry/logging and process exit after it                                                                 |
| `outer − guest`                                          | Serialization, host/guest admission and scheduling, transport and response handling                                                                 | **Not pure network latency**; guest timer is rounded down to integer milliseconds                                                                                               |
| `outer − inner`                                          | Paired residual around application work                                                                                                             | Not guaranteed savings and never a subtraction of percentile values                                                                                                             |

Temporary diagnostic intervals partition guest wall time: cancellation/cgroup
creation; command preparation plus spawn; I/O worker setup; wait through
group cleanup/reap; containment cleanup; remaining stdin/drain joins and result
handling. The refined version splits preparation from spawn without changing
the boundary of their combined interval. `prepare_spawn_us` is their **enclosing
total**, not an additional additive phase.

Input writing and output drains overlap child execution. The child application
timer overlaps I/O setup/wait; do not add it to those intervals. The first-call
wait interval also includes initialization, terminal logging, and scheduling
outside the child timer. No absolute timestamp is subtracted across host/guest
clocks. Quantized residuals retain their signed values; missing events are not
zero-filled. Fallback `guest_ms` describes its final generic exec, not all three
fallback operations, and is not the dedicated middle boundary.

## Environment and workload

- Source: `16d1e9a9b2bcd80e20ae37dfd64584814c46b531`, Runner `0.188.7`.
  All guest binaries use this source; only guest-init receives the experimental
  guest-control timing patch in diagnostic images.
- Build: Rust `ci` profile, `x86_64-unknown-linux-musl`, optimized thin LTO,
  four codegen units, no `test-support` or debug assertions. This is the normal
  development Runner build profile, **not** the production full-LTO release.
- Approved shared development host: `local-11.gcp.vm3.ai`, kernel
  `6.17.0-1018-gcp`, 16 logical CPUs (Xeon Platinum 8581C), 32,086 MiB RAM.
  Roughly 29 GiB was available. This is not a production host or a dedicated
  machine; unrelated development services were not stopped or replaced.
- Profile: `vm0/default`, 2 vCPUs, 4,096 MiB guest memory. Normal production
  Workload cgroups, identity drop, security hooks, process-group ownership,
  output bounds, and lifecycle cleanup remain enabled.
- Existing `runner benchmark` owns the proxy, VM, COW devices and namespace pool.
  It prefetches snapshot memory. Every trial starts a new snapshot-restored VM;
  every 100-call batch is followed by normal `park()` / `unpark()` with the
  default balloon controller. This is a lifecycle analogue, not a complete
  API-admitted Exact run with an active agent and its working set.
- Logs use the production home-based runtime directory, not tmpfs. No real
  manifests, customer data, provider calls, or real API token are used. R2
  credentials were supplied only to the ordinary image builder to read its
  cached template, never to measurement output.

Each trial has 324 storage invocations: one first call; three batches of 100
repeated cached calls with one resumed call after each batch; ten high-work
calls; ten oversized calls. The cached fixture has 17 cached mounts, one with
instruction normalization still requested. The archive fixture has 140 local
`file://` mounts, each extracting a 4-KiB payload. The oversized cached fixture
exceeds the 65,536-byte dedicated stdin limit via a 70,000-character synthetic
name and exercises remove/write/generic-exec fallback. Its child removes the
canonical temporary manifest. Instruction content, all extracted payload sizes,
fallback manifest removal, successful exit and untruncated output are checked.

Archives warm during each trial; high-work results are not a fixed cold-cache
distribution. Fixtures and their reset/order are identical between images.
The actual planner's true-no-work case is checked separately by the existing
Runner entry-point test and has **no helper invocation**, not a zero-ms helper
sample. Existing storage integration coverage validates normalization, nested
mount ordering and extraction security beyond this synthetic fixture.

## Evidence and distributions

Formal runs: `A1, I1, A2, I2, A3, I3` alternated at 05:35:54–05:36:47 UTC;
`G1/G2` were started together at 05:41:04–05:41:15;
`J1–J3` refined the spawn split at 06:02:10–06:02:36.
A/G use uninstrumented guests; I uses six wall intervals; J adds the two
preparation/spawn subintervals. Do not pool these builds or lifecycle categories.

All **3,564 / 3,564** formal invocations have successful complete child pairs,
with no truncated captures. Each A/I/J set has 900 repeated cached, 3 first,
9 resumed, 30 high-work and 30 oversized observations; G has 600/2/6/20/20.
An earlier 324-call calibration used tmpfs logs and is excluded. A subsequent
resource-tool availability check failed before the first storage invocation:
guest `command -v strace` returned 127, not 1. It was fixed before formal runs.
That failed setup is not counted as a successful trial or silently rerun away.

Nearest-rank distributions below are **p50 / p90 / p95 / p99 in milliseconds**.
Every residual is calculated per pair before percentile selection. Each row
contains 300 repeated cached calls, preserving individual trial identity.

| Trial | Probe outer                    | Guest result   | Child inner   | Outer − inner                  | Outer − guest                |
| ----- | ------------------------------ | -------------- | ------------- | ------------------------------ | ---------------------------- |
| A1    | 4.120 / 6.326 / 7.277 / 8.026  | 3 / 5 / 6 / 7  | 0 / 1 / 1 / 2 | 3.974 / 6.318 / 7.130 / 8.026  | .974 / 1.355 / 1.480 / 2.900 |
| A2    | 3.899 / 6.306 / 7.332 / 13.038 | 3 / 5 / 6 / 10 | 0 / 0 / 1 / 1 | 3.764 / 6.282 / 7.332 / 10.038 | .909 / 1.296 / 1.383 / 1.744 |
| A3    | 3.796 / 5.978 / 6.730 / 8.488  | 3 / 5 / 6 / 7  | 0 / 0 / 1 / 1 | 3.746 / 5.834 / 6.526 / 8.488  | .869 / 1.317 / 1.390 / 1.546 |

The three 100-call batch outer p90s are A1 `4.500 / 7.277 / 6.318`,
A2 `4.016 / 7.431 / 6.589`, A3 `3.882 / 6.191 / 6.444` ms. Warm calls after
resume are not identical to the pre-park batch; they were not discarded.

Small lifecycle cohorts are reported as individual values, **not stable tails**:

| Trial | First outer | Three first-after-resume outer observations |
| ----- | ----------: | ------------------------------------------- |
| A1    |      30.760 | 34.544 / 18.811 / 35.014                    |
| A2    |      24.761 | 25.567 / 24.523 / 21.278                    |
| A3    |      35.066 | 21.677 / 23.286 / 29.321                    |

These reproduce a residual on the same scale as the historical production
report, but do not establish its fleet cause: production Runner versions,
manifests, host load and working sets differ. The production p90 residual of
32 ms must not be interpreted as 32 ms available to remove.

### Guest attribution and perturbation

| Repeated-call phase                 |   I1 p50/p90 |   I2 p50/p90 |   I3 p50/p90 |
| ----------------------------------- | -----------: | -----------: | -----------: |
| Cancellation + containment creation |  .432 / .932 |  .422 / .970 |  .418 / .969 |
| Command preparation + spawn         | .623 / 1.995 | .601 / 1.680 | .652 / 1.816 |
| I/O setup                           |  .100 / .311 |  .108 / .351 |  .125 / .376 |
| Wait/completion/group reap          | .787 / 1.448 | .817 / 1.478 | .805 / 1.433 |
| Containment cleanup                 |  .240 / .462 |  .217 / .440 |  .208 / .490 |
| Remaining joins/result handling     | .151 / 2.995 | .144 / 3.129 | .171 / 3.028 |

These are phase percentiles, not additive components of outer p90. The join
interval is measurable but below the proposed 5-ms screen at p90. The 50-ms
cancellation interval does not impose a 50-ms delay on fast child exits.

I1/I2/I3 outer p50/p90 are `3.741/6.526`, `3.679/6.205`, `3.952/6.074` ms.
Compared to adjacent A trials, absolute p50 changes are at most .379 ms and p90
changes at most .200 ms: below 1 ms and within observed baseline batch variation.
This is a descriptive perturbation check, not a statistical equivalence result.
The much smaller first/resumed cohorts cannot establish sub-ms perturbation.
**No clocks or new success diagnostics remain enabled in product code.**

The later J refinement, not interleaved for a causal overhead comparison,
confirms that preparation is only 6–7 microseconds on resumed samples:

| Trial | Resumed spawn intervals (ms) | Repeated spawn p50/p90 (ms) |
| ----- | ---------------------------- | --------------------------: |
| J1    | 24.815 / 15.782 / 9.188      |                .543 / 1.887 |
| J2    | 15.437 / 9.298 / 22.167      |                .551 / 1.970 |
| J3    | 15.932 / 14.777 / 16.352     |                .532 / 1.831 |

## Correctness and resource guardrails

High-work outer p50/p90/max: A1 `64.470/160.397/191.758`,
A2 `61.141/139.951/186.245`, A3 `62.968/124.718/225.993` ms.
Oversized fallback: A1 `23.759/40.971/51.342`, A2 `23.119/40.849/66.298`,
A3 `23.201/35.636/69.729` ms. Each row has only ten observations; p95/p99 would
equal the observed maximum and are not stable tail estimates. Do not combine
fallback and dedicated residuals. There is no optimization treatment for which
these guardrails could demonstrate a performance improvement.

G1/G2 outer repeated p50/p90/p95/p99 were `4.056/6.103/6.600/7.329` and
`3.773/6.394/7.143/15.359` ms. Both completed all 324 calls and cleanup. G2's
p99 exceeds the isolated A maxima of their p99s; do not claim zero tail
regression from this small contention check. Concurrent startup also serialized
some proxy initialization (one proxy took 3.762 s versus 1.866 s); proxy startup
is outside the storage timer.

For A1–A3, the aggregate guest exec-cgroup CPU delta was 1.662/1.691/1.681 s
across each complete fixture, including setup/high-work/fallback. Available
guest memory after the fixture was 3,404–3,433 MiB versus 3,455 MiB before.
The G trials used 1.680/1.717 s aggregate exec-cgroup CPU, with 3,432/3,400 MiB
available afterward. These are not per-helper CPU or peak-RSS measurements.
Parent cgroup pressure counters stayed zero; they do not independently prove
every removed leaf's CPU history. Guest PSI and strace are unavailable.

During concurrent startup, host available memory was 29,182 → 29,181 MiB.
Host PSI total deltas were CPU some 69,425 us, memory some 1,734 us, and I/O
some 16,149 us; avg10 remained 0.00. `/usr/bin/time -v` reported 10.65/10.71 s
process-tree CPU and 10.75/8.91 s wall time for G1/G2. Its maximum RSS is **not**
aggregate VM memory, so it is not used as a VM-memory guardrail. The snapshot
and image cache remain warm and host pressure is not attributable solely to us.

Before and after each fixture, the only exec cgroup present was the resource
probe's own current operation. Every park passed the reusable/quiescent gate;
normal teardown released the VM, COW slots, namespace pool and proxy. Existing
development services remained active. Inactive experiment binaries/configs and
bounded logs were retained for audit; no host-wide GC or production action ran.

## Reproduction artifacts

These patches are **opt-in, disposable experiment code**, not production APIs.
Use a separate clean checkout of the pinned revision on an approved development
host. Never apply them to an active service or run them with customer input.
`probe.patch` adds a private magic benchmark command solely to exercise the
real Sandbox entry points. Its final log reader uses `.get()` instead of the
indexed lookups in the measured binary; this lint cleanup is after all timers.
It also omits failure diagnostic text from measurement JSON; fatal errors still
fail the trial. Only fixed numeric success phases are emitted by the guest patch.
`guest-phases.patch` and its test reproduce the J refinement. The recorded I
instrumentation predated `command_prepared` and the `prepare_us`/`spawn_us`
fields; it had six fields, retaining their enclosing timer.
The patch also adjusts the opt-in connection test to require numeric phase
diagnostics on success; the unpatched production contract still requires an
empty success diagnostic. Do not deploy the experimental diagnostic contract.

```bash
git apply --check /path/to/this/report/probe.patch
git apply /path/to/this/report/probe.patch
cd crates
CARGO_BUILD_JOBS=4 cargo build --profile ci --target x86_64-unknown-linux-musl \
  -p runner -p guest-agent -p guest-storage-apply -p guest-init \
  -p guest-state-restore -p guest-write-file -p guest-tool-exec \
  -p runner-rpc-client -p claude-mock -p codex-mock
```

Preserve baseline guest-init before applying the guest timing patch and
rebuilding only guest-init. Use `runner build --profile vm0/default` with
explicit paths for **all nine** guest binaries (the corresponding `--guest-*`,
`--runner-rpc-client`, `--claude-mock`, `--codex-mock` flags). Then use
`runner config` with each returned rootfs/snapshot hash and a unique benchmark
group/base directory, `--max-concurrent 1`, the approved hostname, a deliberately
non-serving API URL and synthetic token. Do not invoke the normal service
deployment script: it stops/replaces its configured service and runs GC.

```bash
set -o pipefail
sudo /path/to/experimental/runner benchmark issue-32428-storage-probe \
  --config /path/to/isolated/runner.yaml --profile vm0/default \
  2>&1 | tee /path/to/private/trial.log
jq -Rc 'select(startswith("{")) | fromjson' /path/to/private/trial.log \
  | jq -s -f /path/to/this/report/summary.jq
bash /path/to/this/report/test-summary.sh
```

Require benchmark exit zero and complete teardown as well as the summarizer's
coverage check. The summarizer validates exact outer sample order and requires
324 successful, untruncated outer observations and 324 valid child observations.
Ordinal pairing is valid **only for this serial, single-owner synthetic log**;
never apply it to interleaved production telemetry. The script exposes the
number of diagnostic samples and keeps shape/phase/batch groups separate.
`by_shape_phase` additionally summarizes each lifecycle category within that
single trial (including the 300 repeated calls), never across trials or builds.
Its small-cohort percentile outputs are mathematical order statistics, not
evidence of reliable p99 estimates.

### Binary and image identities

| Binary                                       | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Experimental Runner, common to formal trials | `24860411eca09149431fad26b4dde60afc94f5c946332593be897e051ff1aff5` |
| Baseline guest-init                          | `184177ddf2924f13f66562e7197513e48deea44541ef6870c66f26b8ff1dde4a` |
| I guest-init                                 | `848967c455697dc309057ca7dbfcb864710823f3a8769d13dfeea0e48d167ca1` |
| J guest-init                                 | `6b80eebffb8e7fe07dffa2f8cdeaeff64d9247a331134f5a56e56efe4deb3eae` |
| Unchanged guest-storage-apply                | `adb21481c0d39cb5e474715db16883b9fddcc6775d3c0f20697618d9db6ce837` |

| Image | Rootfs hash                                                        | Snapshot hash                                                      |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A/G   | `203c5532218d920b96643368e9176fd106a6b249d8f342df322fa102e5c3200f` | `17209ec83aaf0265273510d120ade287e07c1fe02b375d0810fbb473080e47c8` |
| I     | `44cefd79e584311bf58b0b0b046a4d5f1e597fe4a13fb36821c68b215ca38517` | `077b4983652150e781689bbd2183463588ca5fdb23e0afd3536785dd07631b39` |
| J     | `bbb9969eee46deef458129fc7da5aaddcb62e0f1773092c2791514a5015bbb38` | `9451edaf630308ee570c45aa76ebd50a0dd94ee97e237688537aab1a1984c636` |

Raw synthetic JSON Lines are retained in the workflow's ignored research
directory, with full Runner logs in the isolated host experiment directory.
They are intentionally not ingested into production telemetry. The tables
above are the checked-in result; all statistics can be recalculated from a
fresh trial with the included summarizer.

## Validation

The real-guest runs above are the performance/containment evidence. Local
connection tests use TestNoop and are correctness checks, not cgroup benchmarks.
Selected checks were run in the foreground:

```bash
bash docs/benchmarks/storage-helper-attribution/test-summary.sh
bash -n docs/benchmarks/storage-helper-attribution/test-summary.sh
shellcheck docs/benchmarks/storage-helper-attribution/test-summary.sh
pnpm -C turbo exec prettier --check ../docs/benchmarks/storage-helper-attribution/README.md
# From crates, with CARGO_BUILD_JOBS=4:
cargo fmt --all -- --check
cargo clippy --profile local -p runner --bins -- -D warnings
cargo clippy --profile local -p guest-control-server --all-targets --all-features -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --profile local -p guest-control-server --no-deps
cargo test --profile local -p runner storage --all-targets --all-features
cargo test --profile local -p guest-control-server --test connection guest_storage_manifest --all-features
cargo test --profile local -p guest-storage-apply --all-targets --all-features
```

Runner's storage selection passed 204 tests (its existing isolated-process
helper is invoked by its parent test). The eight storage connection tests passed
both without the diagnostic patch and with the patch's explicit experimental
success-diagnostic assertion. Storage-apply's full selected suite passed.
The summarizer was also run successfully on all eleven complete formal logs;
its CLI regression test checks paired quantiles and rejects incomplete, failed,
truncated, reordered and malformed observations. Both patches apply cleanly
to the pinned source. No Rust source changes are retained by this PR.
