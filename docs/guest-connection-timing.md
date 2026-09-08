# Guest connection timing

Issue [#32444](https://github.com/vm0-ai/vm0/issues/32444) attributes host-observed
guest control connection work. It does not change the handshake or establish
that its duration is removable.

## Boundaries

The connection task is submitted before backend launch and snapshot restore.
Submission is not proof that the listener has bound. All milestones use the
same host `std::time::Instant` clock, not guest timestamps or Tokio virtual time.

| Phase            | Full interval                                                           |
| ---------------- | ----------------------------------------------------------------------- |
| `task_schedule`  | Task submission to the connection operation's first poll                |
| `listener_setup` | First poll to successful listener bind                                  |
| `accept`         | Listener bind to accepted stream                                        |
| `ready`          | Accept to decoded READY, including listener unlinking and decoder setup |
| `ping`           | READY to complete PING write                                            |
| `pong`           | PING write to decoded PONG with the expected sequence                   |
| `client_setup`   | PONG to client initialization and reader task submission                |
| `task_handoff`   | Connection operation completion to startup caller observation           |

These are host observations: accept includes time before the guest connects;
READY/PONG include host scheduling and decoding, not just network transit.
Handoff can contain backend work after an already completed connection.
They do not identify guest retry counts, kernel/vsock causes or guest scheduling.

The five `SandboxStartStage` intervals remain the non-overlapping startup
critical path. In particular,
`runner_fresh_sandbox_start_guest_connection_wait` still starts after backend
launch and optional snapshot restore and ends when the caller observes its
connection result or process exit. Its duration is recorded before detail
callbacks run.

For each detail interval `[phase_start, phase_end]`, `remaining` is its
intersection with that same invocation's residual wait interval. Completed
connection phases have zero remaining duration when they finish before the
residual wait begins. The final handoff interval accounts for caller observation.
The residual phase sum covers the parent interval up to its small final timer
observation gap; it is not a second duration to add to that parent.

## Telemetry and coverage

Runner emits at most eight pairs of fixed action names per returned connection
attempt:

```text
runner_fresh_sandbox_start_guest_connection_<phase>_full
runner_fresh_sandbox_start_guest_connection_<phase>_remaining
```

No new action dimensions, socket paths, addresses, sandbox/session identities or
arbitrary errors are added. Records use the existing collector and flush policy.
The API schema and runner/guest wire protocol are unchanged. Existing observer
implementations can omit this optional detail through the default callback.

Ordinary I/O errors return the completed milestone prefix, the failed phase
ending at operation completion, and a successful task-handoff observation.
Handoff success means the result was returned, not that connection succeeded.
The original error and existing failed parent event remain authoritative.
Aborted or panicked tasks cannot return detail; backend/snapshot failures and
caller cancellation can also leave it absent. Missing detail is not zero or
success. Do not derive fleet failure rates from complete successful records.

Operation event timestamps are buffer-insertion times, not the individual
milestone timestamps. Do not reconstruct overlap from those timestamps. Full
and remaining durations are already computed from the actual shared timeline.
The existing operation format truncates durations to milliseconds; sub-millisecond
phases can legitimately be zero. Benchmark output retains fractional milliseconds.

Keep exact API/Runner revisions, host, startup/reuse path and retries separate.
Exclude same-run blank-pool hits from true-cold cohorts. A new sandbox can resume
a base VM snapshot; true cold does not necessarily mean fresh OS boot or cold
host page cache. Report event coverage, duplicates, failed/missing records and
ambiguous repeated attempts; do not pair repeated groups by timestamp proximity.
Use fixed query windows/caps and account for late ingestion. Compute distributions
from same-invocation intervals, never by subtracting independent percentiles.

## Reproduction

`runner benchmark` now records startup and guest-connection detail through the
same provider observer. It buffers observations and reports them after startup
timing is captured. Its required command, readiness, exit and cleanup semantics
are unchanged.

```bash
runner benchmark --config /path/to/isolated/runner.yaml --profile vm0/default true
```

This utility warms snapshot memory and disables custom DNS readiness; it does
not measure the full production `api_to_spawn` path. Run baseline/candidate
batches with identical guest artifacts, resource limits and cache policy. Retain
source and binary hashes, rootfs/snapshot identity, host load, success/failure
coverage and serial/concurrent p50/p90/p95/p99 separately. On shared test hosts,
use independent mutable directories and normal artifact locks or a private mount
namespace. Never stop unrelated services, run shared GC or flush host caches.

For a same-source collection-overhead comparison:

```bash
cd crates
cargo run --profile ci -p guest-control-client --example connection_timing_overhead
```

The example performs real Unix-socket READY/PING/PONG exchanges, excludes 40
warmup calls, then emits 2,000 observed and 2,000 unobserved samples in ABBA order.
It buffers output until sampling ends. Keep raw samples and analyze per-batch
as well as overall distributions. This isolates client timestamp collection
with a current-thread runtime; it does not measure Firecracker, production
telemetry serialization/transport or fleet-wide scheduling overhead.

Retain attribution only after integration coverage and the authorized same-host
experiment pass. A later behavior change requires an identified avoidable owner
and its own correctness/tail/resource validation. A no-change decision is valid;
the historical parent wait is not a performance-gain forecast.

## Controlled local-11 experiment (2026-09-08)

The formal VM window was 15:17:02–15:21:03 UTC on
`local-11.gcp.vm3.ai` (x86_64, Linux 6.17.0-1018-gcp, 32 GiB RAM).
Both Runners used baseline `6cc4252ee186826c4fdfef9f385e23585fd4c797`
and the same nine guest binaries built from that revision. The candidate adds
this PR's host instrumentation. Optimized `ci`/x86_64-musl binary SHA-256:

The measured candidate is pre-rebase commit
`967d185c3a620ab05b01ebf3e73e2ad4943761d4`. The PR was subsequently rebased
onto `7558632c0eea9bded6c831fdba33a76c369677aa`, preserving main's independent
DNS-attempt observer alongside the connection callback. The fixed-revision
experiment below was not rerun after that rebase; it is not a measurement of
the final rebased binary.

- Baseline: `fb01ebe8a87b35712b53b402fda7cbae5600b39d8c44cea4b268b7d045bdda32`.
- Candidate: `81b2434de57b5f5b285b0574e846eee8a1a2dcc09f011ba71587c67f4951febc`.
- Overhead example (consuming the record with `black_box`): `1365a41cf8571d85adfbb32c971099e9c1130a92c62bc903945409025b1da529`.

The fixed profile was 2 vCPU, 4096 MiB RAM, 12288 MiB rootfs and 16384 MiB
workspace. Firecracker v1.15.1 and kernel 6.1.155 used the same image:

- Rootfs identity: `2055bdb3f6d74f810902b6626fa28846202135f4ff602444450c1cac8b005428`.
- Snapshot identity: `91ff3b50efa39f3f280f5f21f0e15eadf3084c4a5ec6e6340a073ff5658d91c3`.

A private mount namespace isolated the runner home while retaining host-global
NBD claims and network/socket coordination. No existing service was stopped,
no shared GC ran, and no host caches were flushed. Two existing services and
three pre-existing Firecracker processes remained after testing; the experiment's
live-runner registry and sandbox workspace directories were empty. Images and
raw logs were retained under `/tmp/issue-32444-vm7-20260908` for reproduction.
Host load was 0.64/0.35/0.27 at preparation and 0.00/0.00/0.15 at postflight;
other workloads were not controlled or sampled continuously.

### Coverage and startup comparison

Each invocation ran `runner benchmark ... true` with no API server configured.
Two successful VM warmups were excluded. Serial ABBA ordering produced 20
samples per binary. Twenty pairs of concurrent benchmark processes produced
another 20 per binary, rotating lanes/order. CA/proxy preparation can serialize
these processes: this is not a synchronized two-guest handshake stress test.
All 80 formal invocations succeeded; all 40 candidate invocations had exactly
one parent and eight successful phase records, with no duplicate/missing phases.
Three setup failures (new-home ownership, permissions, missing runners directory)
occurred before formal sampling and are not silently counted as successful starts.

All values below use nearest-rank p50 / p90 / p95 / p99. Each VM cell has n=20;
p99 is the maximum of this small cohort, not a fleet-tail estimate.

| Cohort     | Binary    | Startup ms         | Benchmark total ms        |
| ---------- | --------- | ------------------ | ------------------------- |
| serial     | baseline  | 74 / 76 / 77 / 79  | 3009 / 3054 / 3067 / 3106 |
| serial     | candidate | 72 / 76 / 77 / 77  | 2969 / 3016 / 3025 / 3078 |
| concurrent | baseline  | 73 / 77 / 79 / 100 | 4710 / 4962 / 4973 / 4987 |
| concurrent | candidate | 74 / 79 / 82 / 86  | 3081 / 4978 / 4994 / 4999 |

The benchmark total includes proxy preparation, which explains the concurrent
bimodality; do not interpret its median difference as instrumentation savings.
Startup distributions do not show a consistent cross-cohort increase, but do
not bound a small regression or production tails.

### Connection attribution

Full and remaining milliseconds, p50 / p90 / p95 / p99:

| serial phase  | Full ms                         | Remaining ms                      |
| ------------- | ------------------------------- | --------------------------------- |
| TaskSchedule  | 0.024 / 0.032 / 0.034 / 0.065   | 0 / 0 / 0 / 0                     |
| ListenerSetup | 0.039 / 0.052 / 0.06 / 0.063    | 0 / 0 / 0 / 0                     |
| Accept        | 66.32 / 69.453 / 69.54 / 70.452 | 44.995 / 46.871 / 47.398 / 48.244 |
| Ready         | 2.52 / 2.863 / 3.11 / 3.122     | 2.52 / 2.863 / 3.11 / 3.122       |
| Ping          | 0.007 / 0.011 / 0.012 / 0.012   | 0.007 / 0.011 / 0.012 / 0.012     |
| Pong          | 3.98 / 4.368 / 4.665 / 5.314    | 3.98 / 4.368 / 4.665 / 5.314      |
| ClientSetup   | 0.022 / 0.026 / 0.037 / 0.042   | 0.022 / 0.026 / 0.037 / 0.042     |
| TaskHandoff   | 0.05 / 0.067 / 0.073 / 0.082    | 0.05 / 0.067 / 0.073 / 0.082      |

Residual parent: 51.562 / 53.25 / 54.562 / 56.49 ms. Maximum same-invocation parent-minus-phase
sum gap: 0.000475 ms (final timer observation).

| concurrent phase | Full ms                           | Remaining ms                      |
| ---------------- | --------------------------------- | --------------------------------- |
| TaskSchedule     | 0.02 / 0.031 / 0.033 / 0.068      | 0 / 0 / 0 / 0                     |
| ListenerSetup    | 0.035 / 0.042 / 0.043 / 0.047     | 0 / 0 / 0 / 0                     |
| Accept           | 66.872 / 70.762 / 75.707 / 80.202 | 44.827 / 47.424 / 48.496 / 59.445 |
| Ready            | 2.545 / 3.072 / 3.43 / 3.506      | 2.545 / 3.072 / 3.43 / 3.506      |
| Ping             | 0.007 / 0.009 / 0.01 / 0.014      | 0.007 / 0.009 / 0.01 / 0.014      |
| Pong             | 3.953 / 4.381 / 4.419 / 4.566     | 3.953 / 4.381 / 4.419 / 4.566     |
| ClientSetup      | 0.02 / 0.025 / 0.025 / 0.03       | 0.02 / 0.025 / 0.025 / 0.03       |
| TaskHandoff      | 0.052 / 0.072 / 0.087 / 0.095     | 0.052 / 0.072 / 0.087 / 0.095     |

Residual parent: 50.952 / 54.83 / 56.672 / 65.849 ms. Maximum same-invocation parent-minus-phase
sum gap: 0.000449 ms (final timer observation).

Accept is the largest residual phase in these measurements. Task scheduling
and listener setup completed before the parent wait in all 40 samples. The
roughly 21 ms difference between full and remaining accept in an individual
sample is overlapped work, not an additional startup cost. Host observations
still do not identify a guest retry, kernel delay or removable owner.

### Collection overhead and decision

The final real-socket run excluded 40 warmups and retained 2,000 samples per
mode in 1,000 ABBA batches. Microseconds, p50 / p90 / p95 / p99:

| Mode       | Duration µs                      |
| ---------- | -------------------------------- |
| Unobserved | 42.416 / 50.826 / 55.54 / 70.748 |
| Observed   | 42.557 / 50.657 / 55.342 / 75.65 |

Within-batch mean observed-minus-unobserved differences had mean
0.382 µs and p50 / p90 / p95 / p99
-0.013 / 5.703 / 9.831 / 66.828 µs. Negative values reflect noise,
not a speedup. This measures client collection. The VM comparison also exercises
the provider callback and CLI reporting; neither directly measures production
`JobTelemetry` recording, batch serialization or HTTP ingestion cost.

Decision: retain attribution for further evaluation, with **no handshake,
listener-order, retry or deadline change**. Accept dominates this local residual,
but its internal cause and avoidability remain unknown. Before closing #32444,
finish the production-collector recording/batch overhead check; this PR uses a
non-closing issue link. Production rollout/soak and the parent's historical
latency cohorts are not validated by this isolated experiment.
