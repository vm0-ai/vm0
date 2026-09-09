# Workspace history guest-write attribution (#32475)

This is an **experiment and decision record**, not a production optimization.
It completes the attribution slice [#32475](https://github.com/vm0-ai/vm0/issues/32475)
under [#24203](https://github.com/vm0-ai/vm0/issues/24203). No production Rust,
API, protocol, cache, timeout, or concurrency policy is changed. Neither patch
is applied by the build/release workflow.

## Decision

Keep the current production write path in this slice. The controlled measurements
support several contributors, not one removable “disk write” delay:

- At 32 MiB, the first observed write has 454.39 ms p50 total. Host frame
  write/writer-lock time has 139.03 ms p50, terminal-response waiting 269.08 ms;
  inside the Guest, payload copy plus queueing has 120.64 ms and the complete
  helper handlers 132.63 ms. These are nested/overlapping views, **not additive
  independent percentile components**.
- Each chunk's helper lifecycle is material. The 32 MiB three-chunk first-write
  helper-spawn sum has 19.52 ms p50; helper setup/child waiting has 97.29 ms.
  The helper copy includes stdin waiting and filesystem work, so it cannot
  establish pure disk latency.
- The separate final publication costs 17.97 ms p50 for that first-write cohort
  (27.03 ms for repeats). It is not the dominant owner. The
  15 MiB + 1 byte case pays for a second one-byte chunk/helper and publication;
  its baseline first-write p50 is 258.24 ms versus 223.45 ms at exactly 15 MiB.
  This is descriptive, not an estimate of removable cost.
- Host gate/frame-builder contention, stdin joining and stderr draining are
  small in these cohorts. They do not explain the historical one-second tail.
- Native Codex zstd is already preserved. The compressible 32 MiB fixture
  transfers only 1,202 bytes; the low-compressibility fixture transfers
  25,171,356 bytes and takes two chunks. Raw metadata size alone is unsuitable
  for attribution. This is not evidence to introduce another compression path.
- Probes perturb the measurement, especially small writes. The observed
  32 MiB first/repeat p50 exceeds baseline by 32.28/38.28 ms (7.65%/16.34%);
  small first-write p50 increases 2.68 ms (21.33%). Individual tail
  differences change sign. Do not subtract a universal “probe correction”
  or ship this stderr instrumentation as low-overhead production telemetry.

**Next investigation:** separate allocation/copy from scheduling in the existing
Guest worker's `payload.to_vec()` plus queue interval, and separate host socket
backpressure from shared-writer waiting. These bulk stages merit investigation
before a new final-publish operation or persistent helper. This evidence alone
does not authorize removing an owned copy, bypassing single-active admission,
parallelizing chunks, or changing helper containment.

A later optimization must compare uninstrumented old/new builds with the same
fixtures and representations, first-write/repeat/concurrent cohorts, exact-byte
verification, and write/publication failure plus cancellation tests. Preserve
path/identity validation, permissions, unique staging and atomic publication,
deadlines, process-group cleanup, and cancellation fencing. Separately validate
Runner/API and persisted workspace-cache compatibility.

## Scope and limits

The source baseline is
`cede9cbfb62872ddabb705de852dc6fd81a3cc6d` (Runner 0.188.19).
The fixed production cohorts recorded in the issue used older revisions and
missing size/representation metadata. They were **not remeasured** here.
This experiment does not reproduce or explain their 1.1–1.2 second p90.

The harness enters real `restore_session()` and `Sandbox::write_file()`
after benchmark workspace mount and Guest preparation, before its final
`true` command. It uses a fresh snapshot-restored VM with a blank workspace
drive, not a full workspace-cache hit or remote download. Synthetic already-
materialized histories avoid model, provider and API calls.

Claude, Codex and Pi destinations are exercised. The fixture is valid JSONL
with a synthetic header/text; it tests transfer and exact bytes, **not** each
provider's full session parser or a real resumed model turn. Native zstd is
round-trip verified before sampling. Host fixture reads/cloning, fixture
generation, VM/proxy startup and byte verification are outside the write timer.
The full contents are copied back and compared after **every** write.

Every invocation uses lifecycle-proven fresh/`PoolMiss` restore semantics.
“Repeat” means another write to the same destination in the same VM, **not**
exact sandbox reuse. Byte verification warms the repeated-write cohort; do not
combine it with first writes. Existing full-run tests cover preparation ordering
and exact-reuse behavior separately.

Percentiles use nearest rank. Serial cohorts have only four independent VMs
per case/arm and sixteen repeats clustered within those VMs. Thus first-write
p90/p95/p99 and repeat p95/p99 are sample maxima, not reliable population tails.
No samples are discarded for being slow.

## Measurements

Serial collection ran on September 9, 2026, 07:27:38–07:33:03 UTC on
`local-11.gcp.vm3.ai`. Two alternating blocks, two VM processes per
case/arm/block, five writes per VM: **72 processes, 360 verified writes,
zero process/write/verification failures**. A separate smoke cohort had
12 processes/24 verified writes and is excluded from the tables.

The committed [serial records](serial.jsonl) retain per-invocation nanoseconds,
outcomes, actual transfer sizes, representation, block/VM identity and whole-
process CPU/RSS/load. [Fixture metadata](fixtures.json) records exact bytes and
SHA-256. No user histories are included.

### First write in a fresh VM

Four samples per row/arm; milliseconds, **p50 / p90 / p95 / p99**.

| Case              | Baseline                          | Observed                          |
| ----------------- | --------------------------------- | --------------------------------- |
| small             | 12.57 / 13.50 / 13.50 / 13.50     | 15.25 / 17.66 / 17.66 / 17.66     |
| below             | 226.29 / 277.85 / 277.85 / 277.85 | 229.82 / 246.43 / 246.43 / 246.43 |
| at                | 223.45 / 239.11 / 239.11 / 239.11 | 234.53 / 240.14 / 240.14 / 240.14 |
| above             | 258.24 / 281.02 / 281.02 / 281.02 | 264.50 / 281.69 / 281.69 / 281.69 |
| large             | 422.12 / 431.45 / 431.45 / 431.45 | 454.39 / 466.53 / 466.53 / 466.53 |
| codex             | 14.06 / 17.58 / 17.58 / 17.58     | 19.24 / 30.63 / 30.63 / 30.63     |
| pi                | 13.40 / 16.50 / 16.50 / 16.50     | 17.09 / 21.56 / 21.56 / 21.56     |
| native-zstd       | 13.81 / 15.55 / 15.55 / 15.55     | 17.58 / 19.51 / 19.51 / 19.51     |
| native-zstd-large | 326.43 / 333.43 / 333.43 / 333.43 | 336.60 / 382.16 / 382.16 / 382.16 |

### Repeated writes in the same VM

Sixteen samples per row/arm; milliseconds, **p50 / p90 / p95 / p99**.

| Case              | Baseline                          | Observed                          |
| ----------------- | --------------------------------- | --------------------------------- |
| small             | 6.46 / 7.65 / 12.27 / 12.27       | 6.42 / 13.11 / 19.02 / 19.02      |
| below             | 95.30 / 161.50 / 170.79 / 170.79  | 101.86 / 166.61 / 172.16 / 172.16 |
| at                | 99.11 / 156.56 / 162.17 / 162.17  | 100.43 / 162.25 / 193.15 / 193.15 |
| above             | 110.12 / 181.45 / 192.31 / 192.31 | 134.98 / 182.95 / 188.32 / 188.32 |
| large             | 234.24 / 351.91 / 353.52 / 353.52 | 272.52 / 361.42 / 388.47 / 388.47 |
| codex             | 6.50 / 8.62 / 12.28 / 12.28       | 10.49 / 19.22 / 19.78 / 19.78     |
| pi                | 6.74 / 10.53 / 11.09 / 11.09      | 9.08 / 14.82 / 17.27 / 17.27      |
| native-zstd       | 6.43 / 7.86 / 8.18 / 8.18         | 3.08 / 12.34 / 12.56 / 12.56      |
| native-zstd-large | 177.73 / 256.29 / 263.25 / 263.25 | 189.25 / 271.10 / 284.58 / 284.58 |

## Instrumented stage breakdown

32 MiB Claude raw, three sequential chunks. Milliseconds; first n=4,
repeat n=16. Every listed stage is present for all those invocations.
Quantiles describe each stage independently; do not add table cells.

| Phase (sum across chunks) | First p50 / p99   | Repeat p50 / p99  |
| ------------------------- | ----------------- | ----------------- |
| host_gate                 | 0.003 / 0.003     | 0.002 / 0.003     |
| host_builder_wait         | 0.001 / 0.001     | 0.001 / 0.001     |
| host_encode               | 16.636 / 19.481   | 16.976 / 18.946   |
| host_write_with_lock      | 139.028 / 167.707 | 85.869 / 128.553  |
| host_reply                | 269.076 / 280.904 | 138.645 / 214.489 |
| host_publish              | 17.970 / 24.764   | 27.028 / 33.073   |
| host_chunk_residual       | 1.614 / 1.925     | 1.361 / 1.728     |
| host_outer_residual       | 0.089 / 0.108     | 0.095 / 0.665     |
| guest_queue_copy          | 120.637 / 129.694 | 34.111 / 122.140  |
| guest_handler             | 132.630 / 151.844 | 85.561 / 104.596  |
| guest_spawn               | 19.523 / 20.122   | 15.298 / 18.025   |
| guest_child_setup         | 97.293 / 115.266  | 54.285 / 76.486   |
| guest_stdin_join          | 0.016 / 0.029     | 0.030 / 0.143     |
| guest_stderr_drain        | 0.023 / 0.047     | 0.044 / 0.073     |
| guest_handler_residual    | 17.013 / 20.512   | 17.732 / 24.061   |
| guest_open                | 1.082 / 1.084     | 1.495 / 1.881     |
| guest_copy_stdin_overlap  | 94.934 / 113.875  | 55.594 / 77.201   |
| guest_flush               | 0.000 / 0.001     | 0.000 / 0.001     |
| guest_stdin_overlap       | 91.106 / 108.821  | 48.323 / 70.483   |

### Timing semantics

- `host_path`: operation/path admission and validation before chunking.
- `host_gate`: per-connection file-write gate wait. `host_chunks` includes it.
- `host_builder_wait`, `host_encode`, `host_write_with_lock` and
  `host_reply`: same-process intervals around existing frame construction,
  shared writer/socket write, and terminal wait. Socket write includes
  backpressure; reply wait is not “Guest CPU”.
- `guest_queue_copy`: payload-owned copy and queue-to-worker scheduling,
  starting after the complete frame has arrived. It does not measure frame
  reception or separate allocation, memcpy and scheduling.
- `guest_handler`: Guest decoding, helper lifecycle and diagnostic output.
  `guest_spawn` and `guest_child_setup` separate spawn from setup/child wait;
  stdin feed runs concurrently, then the worker joins stdin and drains stderr.
- `guest_open`, `guest_copy_stdin_overlap`, `guest_flush`: helper open/
  parent-directory creation, unchanged `io::copy`, and `File::flush`.
  **Flush is not fsync**. Copy includes pipe waiting and filesystem I/O.
  `guest_stdin_overlap` overlaps helper copy/child wait. These are not additional
  serial terms. Cross-thread scheduling may make one measured interval longer
  than another overlapping interval.
- `host_publish`: complete bounded generic-exec `mv -fT` lifecycle after
  all chunks acknowledge, not just the rename syscall. Single-chunk writes
  have no publication operation; its measurement remains null.
- Residuals are subtracted **within each invocation and process**, then
  aggregated: chunk total minus gate/frame/reply components; outer total
  minus path/chunks/publication; Guest handler minus spawn/setup/wait/join/
  drain. They retain probe emission, decoding, bookkeeping and unmeasured work.
  No Host/Guest wall-clock subtraction or sum of overlapping timers is used.

Correlation uses request sequence within one isolated VM connection.
Guest console output can arrive after the Host ACK; parsing joins after reading
the complete process log. Missing optional phases remain null, never zero.
A malformed or incomplete capture retains a failed process record and raw log;
logs without process records fail analysis. Probe output includes synthetic
identifiers in raw local logs and must not be enabled on user histories.

## Concurrent process cohorts

The [short cohort](concurrent.jsonl) ran at approximately 07:33–07:36 UTC:
48 processes, 240 verified writes, zero failures; two independent VMs per arm,
two blocks, two pairs per block, five writes per VM. Milliseconds:

| Case / lifecycle | n per arm | Baseline p50 / p90 / p95 / p99    | Observed p50 / p90 / p95 / p99    |
| ---------------- | --------: | --------------------------------- | --------------------------------- |
| above / first    |         8 | 276.97 / 305.14 / 305.14 / 305.14 | 273.12 / 288.38 / 288.38 / 288.38 |
| above / repeat   |        32 | 104.85 / 168.35 / 177.26 / 198.59 | 127.52 / 186.31 / 194.22 / 198.75 |
| large / first    |         8 | 423.90 / 481.73 / 481.73 / 481.73 | 454.43 / 494.86 / 494.86 / 494.86 |
| large / repeat   |        32 | 248.53 / 349.28 / 363.43 / 370.82 | 279.62 / 379.49 / 389.45 / 395.71 |
| small / first    |         8 | 12.76 / 14.31 / 14.31 / 14.31     | 19.01 / 22.23 / 22.23 / 22.23     |
| small / repeat   |        32 | 6.53 / 8.36 / 10.75 / 12.28       | 10.39 / 16.34 / 18.92 / 20.01     |

VM setup is staggered by roughly two seconds in many pairs. In particular,
small writes can finish before the other VM starts writing. This cohort checks
concurrent benchmark processes, **not synchronized file-write contention**.

The [long cohort](concurrent-long.jsonl), approximately 07:49–07:51 UTC,
extends the above/large cases to twenty writes per VM: two blocks, one pair
per case/arm/block, 16 processes, **320 verified writes, zero failures**.
These are four first writes and 76 clustered repeats per case/arm, not
80 independent VMs. It is a separate cohort, not pooled with five-write runs.

| Case / lifecycle | n per arm | Baseline p50 / p90 / p95 / p99    | Observed p50 / p90 / p95 / p99    |
| ---------------- | --------: | --------------------------------- | --------------------------------- |
| above / first    |         4 | 269.40 / 314.41 / 314.41 / 314.41 | 277.50 / 357.00 / 357.00 / 357.00 |
| above / repeat   |        76 | 110.94 / 128.70 / 170.98 / 189.41 | 130.02 / 151.82 / 195.59 / 231.81 |
| large / first    |         4 | 432.48 / 455.63 / 455.63 / 455.63 | 474.93 / 514.83 / 514.83 / 514.83 |
| large / repeat   |        76 | 226.08 / 354.07 / 384.17 / 445.38 | 263.72 / 375.47 / 454.19 / 473.06 |

The raw logs confirm overlapping sustained write/verification series: for
example, `0-0-large-baseline-0.log` reports completions from
07:49:27.185527 through 07:49:34.929298 UTC while slot 1 starts reporting at
07:49:29.123028 and continues during that interval. There is no start barrier;
not every individual timed write overlaps. Byte read-back competes with other
VM activity too. Two independent connections do not stress same-connection
gate contention, and this is not a throughput or production saturation test.

All 920 formal writes across the three cohorts passed. Including the excluded
smoke, **148 processes and 944 writes** completed without failure.
All observed invocation phase fields are present; the only null phase is
publication for the single-chunk cases that do not execute it.

Whole-process resource ranges (includes VM/proxy setup and byte verification,
not isolated write CPU/RSS):

| Cohort           | User + system CPU seconds per process | Max RSS KiB   | Host 1-minute load |
| ---------------- | ------------------------------------- | ------------- | ------------------ |
| serial           | 3.82–8.25                             | 101040–171448 | 0.62–3.96          |
| concurrent short | 3.93–8.59                             | 101040–171312 | 2.93–7.79          |
| concurrent long  | 11.67–21.79                           | 137428–194868 | 1.88–4.89          |

Shared-host activity and the larger observer overhead on small requests limit
causal interpretation. The long-cohort tails remain below one second, so the
original production p90 is still unexplained. No failed samples were hidden
or test timeouts increased.

## Environment and artifact identity

Host: `vm0-local-11.us-west1-b.c.vm0-ai-488909.internal`, x86_64,
16 CPUs, about 32 GiB RAM, host kernel `6.17.0-1018-gcp`.
Profile `vm0/default`: 2 vCPU, 4096 MiB RAM, 12 GiB rootfs,
16 GiB workspace; each experiment Runner allows one VM.
Firecracker `v1.15.1`, Guest kernel `6.1.155`.

Builds used rustc `1.98.0 (88d9e12ae 2026-08-18)`, Cargo 1.98.0,
the `ci` optimized profile, `x86_64-unknown-linux-musl`, and four build jobs.
All ten Guest packages were built together; Runner was built separately,
with identical dependency feature unification in both arms.
The eight other Guest executable files are byte-identical across arms.
[Cargo.lock.txt](Cargo.lock.txt) is the exact experiment lock snapshot
(SHA-256 `55e87ee393bea4ade5f1f6fdf2d27edd731d40a478abe9e93c7ff5b840031031`);
it does not change the repository's normal lockfile policy.

| Binary           | Baseline SHA-256                                                 | Observed SHA-256                                                 |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| runner           | f8f3d8717542ac268c9f0a35c0856f02f659e332486b19581772b8fdabd0e22f | c96cf5094451c9beec2716e721b4962fe08b1e16de120b31c815e389b7e58bad |
| guest-init       | f9ddc65631d5d5f6ae95cbb7223a50b7e8e4d5563c10e4444d98afbf65f3e781 | 8229464119f8700ea7c109c451edb53024b8bf1733e5a640d4d478f60b63669e |
| guest-write-file | 9f4a336bedc1dbf090d63d690ed351d71ee11b3f1f8fce1fbef548dd5d9a8b21 | fc983c5b43548dd215d39a675e8f9d0fa87481e5261a159e857e59df26f18cea |

[images.json](images.json) contains the exact tested rootfs/snapshot hashes.
The template recipe hash was
`53a20d8c70101c440f38ca30e5a6669ef274a306a316a6a3eb967c09a727de7d`.
R2 was disabled. Each arm built its own concrete template using the same
debootstrap package cache; they are **not byte-identical templates**. Verified
matching SHA-256 for the complete dpkg status
(`f0bfe0ede6ff17f948e6a0a2acf888346a5a036b394e390ff384820ee3b765b6`),
libc (`269ffadc51484e5e2cbcb9100a5e1cd78a72493c0e3e7b0611a5a4778718d8e9`)
and mv (`cbb3b945526115f913573c5f2bccf3e1b51c51aace3ba95c18fc30128d9b282d`).
Separate snapshots/templates and shared-host scheduling remain comparison limits.

Four unrelated normal Runner services stayed active during collection. A fifth,
pre-existing issue-32748 experiment service disappeared independently before
sampling; this workflow did not stop or modify it. No service deployment,
production log query, R2 upload/download or global GC was performed.
After collection, no issue-owned benchmark process remained; the four normal
services were still active. About 379 GiB remained free. The issue-owned
fixture/binary/raw-evidence directory occupies 216 MiB, excluding immutable
images and per-Runner extracted dependencies retained for reproduction.

## Reproduction and validation

See [reproduce.md](reproduce.md) for source-pinned build, collection and cleanup
instructions. This is intentionally not a moving-main benchmark API.

Read-only analysis of committed evidence needs only Python 3.12+:

```bash
python3 docs/experiments/workspace-history-write-32475/profile.py analyze \
  docs/experiments/workspace-history-write-32475/serial.jsonl
python3 docs/experiments/workspace-history-write-32475/test_profile.py
```

Instrumented-source validation passed:

- Optimized cross-builds of Runner and all ten bundled Guest executables.
- `cargo fmt --all`; all-target/all-feature Clippy for Runner,
  guest-control-client, guest-control-server, guest-write-file and
  guest-control-tests.
- Rustdoc for those crates with `RUSTDOCFLAGS='-D warnings'`.
- Complete guest-control-client/server/helper/protocol-integration suites,
  including existing write/publication failure and cancellation behavior.
- Runner `session_restore`, full-run `cmd::start::tests::idle_reuse`
  (57 tests), and `cmd::benchmark::tests` (15 tests).
- Five Python CLI tests with real temporary evidence: unknown measurements,
  overlap-safe residuals, missing chunks, failed/missing process denominators,
  percentile aggregation and compact evidence round-trip. Ruff format/lint pass.
- Both patches apply to the pinned source. Production source was restored
  exactly before submission.

This experiment does not add rollout fallbacks or an external telemetry schema.
The principal new risks are misinterpreting synthetic/clustered samples,
observer overhead, stale source-pinned patches, and privileged manual experiment
execution. The reproduction instructions keep those operations explicitly
separate from normal builds.
