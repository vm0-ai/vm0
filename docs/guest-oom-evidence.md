# Guest OOM evidence

This is an observability change for #32818. It neither fixes nor retrospectively
attributes the historical OOMs in #32577, #32668, or the independent comparison
incident documented in #32802. It does not authorize production rollout.

## Ownership and capture

Guest control creates one operation UUID, reads the Guest boot UUID and initial
cgroup inode, actual memory limit and event counters at containment creation.
It owns a nonblocking `/dev/kmsg` descriptor positioned at the current end. The
existing authenticated workload-placement socket carries bounded requests from
Guest Agent's existing five-second metrics task; there is no new sampler, process
scanner or tracing service. Normal telemetry still uploads every thirty seconds.

Only kernel-facility `oom-kill:` records with a recognized constraint, source
time after operation initialization, a new sequence and an owned task cgroup
are retained. The task may belong to this operation's control, runtime or tools
subtree. No victim `/proc` lookup is needed. Only Guest source, monotonic event
time, sequence, constraint, optional triggering cgroup, PID and bounded comm are
retained. Host Firecracker diagnostics remain separate. Paths are checked against
the current operation; cgroup names are not interpreted as victim PIDs. A replaced
cgroup invalidates attribution. Unsupported or absent values remain null.

A new workload OOM counter transition or correlated kernel event records an
incident. A CLI error also records a capture candidate when no incident exists;
its absence of counters/kernel records does not prove OOM. A recovered tool OOM
is observed on the same five-second path or final capture without failing the run.
CLI abnormal completion and root containment cleanup are fallback capture points.
Root captures before cleanup enumerates/signals/removes descendants, emits a
bounded metadata log, and retains the same incident IDs for the terminal frame.
A late kernel record may enrich the matching counter incident without changing
its ID. A kernel-first kill decision can reconcile its later kill-counter tail
only with a fully drained healthy reader and no new OOM attempt. This bounded
correlation excludes control-cgroup victims, resets on kernel uncertainty, and
preserves the original incident time/snapshot. Missing samples remain unavailable
in telemetry while internal comparison retains the last valid counter observation. Cleanup also supplies a fresh final snapshot alongside prior incidents.
Snapshots explicitly describe post-observation values, not exact pre-kill usage.

## Bounds and failure behavior

| Surface                             | Bound                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| cgroups                             | workload, runtime and aggregate tools only; six files each         |
| each cgroup/kernel source read      | 4,096 bytes; oversized sources are unavailable/truncated           |
| kernel pass                         | at most 128 records and four matching events                       |
| capture pass                        | 50 ms budget, checked before each nonblocking source read          |
| retained incidents                  | first four per operation, with a dropped-incident count            |
| serialized socket/terminal evidence | 48 KiB; at most four events per incident                           |
| metadata strings                    | cgroup 256 bytes, comm 16 bytes; no raw kernel record              |
| evidence socket read/write          | separate absolute 200 ms deadlines                                 |
| local Guest file                    | one overwritten private evidence file per run, at most 48 KiB      |
| uploader handoff                    | one latest-value watch slot; no incident queue                     |
| urgent Guest HTTP                   | two attempts of two seconds per changed incident set               |
| in-flight Guest HTTP                | one ordinary upload plus at most one urgent request                |
| Guest HTTP response                 | existing shared client caps: 5 MiB success, 64 KiB error           |
| Runner retention                    | one file per run, 48 KiB maximum, one-second wait; existing log GC |
| Runner HTTP fallback                | one attempt of two seconds, response body at most 1,024 bytes      |
| terminal envelope                   | omitted if it would exceed the existing u16 diagnostic length      |

The 50 ms capture budget bounds work between nonblocking kernel/cgroup reads;
it is not a hard real-time guarantee against a stalled kernel/filesystem syscall.
No diagnostic worker is recursively executed. Permission failures, overwritten
kernel cursors, unavailable fields, uncorrelated records and exhausted budgets
are explicit. Capture/upload failure never changes exit codes, cancellation,
timeout, ownership, cleanup or sandbox-reuse precedence.

The telemetry actor sends a dedicated incident payload before ordinary backlog,
and can send it while an ordinary HTTP response is outstanding. Ordinary position
files remain owned by that actor and retain Live/Final semantics. It retains the
small evidence file even after acknowledgement. Runner independently retains the
terminal copy using the same IDs and the existing seven-day log garbage collector.
Whole-Guest or whole-host loss can still destroy unuploaded data. Local retention
is best effort, not a delivery guarantee or an automatic replay service.

## Wire compatibility and ingestion

Receiver-first deployment is required for reliable new evidence ingestion:
API, then Runner and Guest components. This PR does not perform that deployment.

| Combination           | Behavior                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| old producer, new API | optional fields absent; existing telemetry unchanged                                             |
| new producer, old API | HTTP 200 without `oomEvidenceVersion: 1` is unacknowledged; bounded attempts and local retention |
| new producer, new API | strict validation and configured successful Axiom ingestion precede the version acknowledgement  |

Runner and all Guest binaries ship as one artifact; unsupported mixed versions
need no handshake. The binary Guest-control frame shape does not change. Its
bounded `OKOU_OOM_EVIDENCE_V1` terminal metadata is removed by Runner before
outcome processing. Rust route bindings are regenerated; telemetry has no
generated body consumer to update.

The API validates the same shared fixture used by Rust serialization tests,
authenticates the run with existing sandbox credentials, validates operation
ownership and rejects unknown nested metadata. It projects optional periodic
`memory` data and urgent `guest_memory_snapshot` / `guest_oom_incident` events to
`sandbox-telemetry-metrics`, preserving IDs, source times, availability and values.
`_time` is capture/sample time; `ingested_at` is separate. Duplicate delivery is
possible after an acknowledgement is lost or from Runner fallback; consumers
should deduplicate incidents by `(runId, operation_id, incident_id)`, retaining
an enriched version when present. There is no new database or Axiom dataset.

Only the documented metadata is collected. No prompts, tool content, complete
argv, environment values, credentials, storage content or unrelated tenant kernel
records are added. A killed task is not evidence of dominant allocator ownership.

## Validation scope

Synthetic cgroup files, kernel record/error fixtures, bounded Unix sockets and
local HTTP fixtures exercise capture, cleanup ordering, old/new compatibility,
backlog priority, in-flight uploads, timeouts and retries. Existing isolated
Guest-control/Runner tests cover success, raw SIGKILL, cancellation and timeout.
The API entrypoint tests use the repository's isolated PostgreSQL/MSW facilities.
These fixtures do not prove real kernel OOM delivery. No established safe
isolated kernel OOM environment was available in this run; no intentional OOM,
production workload replay, production validation, full local Vitest or dev server
was used. Exact commands and results are recorded in the PR.

Merged, independently accepted, released and production-verified are separate
states. The controller owns independent acceptance after protected merge.
