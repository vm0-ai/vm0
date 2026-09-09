# Storage apply resource diagnostics

The guest control server takes one resource snapshot before cleaning an
initialized storage-apply cgroup. It returns the snapshot in a dedicated bounded
field of the storage terminal RPC. The Runner validates and logs it as an INFO
`storage apply resources` event, with a JSON `resources` field and the sandbox
`id`. Normal operations, nonzero exits and timeouts are included, not just
CPU-pressure cases. Existing guest pressure and hard-limit warnings remain
separate. Other exec, agent and tool operations do not acquire this snapshot.

Find these events in Runner local logs. Routine INFO evidence is not guaranteed
to be ingested into Axiom. Join the resource JSON `run_id`, `request_seq` and
`group` with the sandbox identity. Group names include process, request and
operation counters. The host binds the evidence to its actual request and only
logs the typed allowlisted fields. Non-UUID-shaped run IDs are `null` without
changing accepted inputs or helper environment.

## Field meanings

| Fields                                                                  | Meaning                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containment_wall_us`                                                   | Time from enabling the summary on the fresh, empty containment (after cgroup creation, before placement/spawn) to starting the pre-cleanup snapshot.                                        |
| `cleanup_mode`                                                          | `Graceful` or `Forced`; this is a cleanup decision, not the helper exit status.                                                                                                             |
| `cpu_usage_usec`, `cpu_user_usec`, `cpu_system_usec`                    | Cumulative CPU time charged to this operation's workload.                                                                                                                                   |
| `cpu_nr_periods`, `cpu_nr_throttled`, `cpu_throttled_usec`              | CPU bandwidth period and accumulated throttling counters.                                                                                                                                   |
| `cpu_quota_us`, `cpu_period_us`                                         | The actual configured workload-leaf `cpu.max`, not effective ancestor limits. Quota `"max"` means unlimited.                                                                                |
| `memory_current_bytes`, `memory_peak_bytes`                             | Charged current/peak cgroup memory. Peak is since creation; no counter is reset.                                                                                                            |
| `memory_high_limit_bytes`, `memory_max_limit_bytes`                     | Actual configured leaf limits; `"max"` means unlimited.                                                                                                                                     |
| `memory_pgfault`, `memory_pgmajfault`                                   | Workload fault counters, not fault durations.                                                                                                                                               |
| `memory_pgscan*`, `memory_pgsteal*`                                     | Scanned/reclaimed page counters, including direct and kswapd variants when supported.                                                                                                       |
| `memory_workingset_refault_anon`, `memory_workingset_refault_file`      | Workingset refault counters when supported.                                                                                                                                                 |
| `memory_events_high/max/oom/oom_kill/oom_group_kill`, `pids_events_max` | The corresponding resource-limit events, shared with existing cleanup diagnostics.                                                                                                          |
| `collection_us`                                                         | Reading and assembling this snapshot, including the three existing event reads; excludes serialization, RPC transport and host logging. Measure those costs separately or in the full call. |

Missing, unreadable, oversized, malformed or unsupported readings are `null`,
never invented zeros. Only allowlisted fields and parsed unsigned values or
`"max"` limits are emitted. Each of nine fixed cgroup files is capped at 16 KiB;
there is no sampling loop, ancestor walk or new background worker. The optional
resource field is capped at 4 KiB and does not replace stdout, stderr or error
diagnostics. The guest does not print this summary to its serial console.
Collection, serialization, result transport and host logging still add
synchronous pre-spawn work; this is not a claim of zero overhead.

Unavailable or unencodable evidence is omitted. Bounded invalid JSON or mismatched
identity is discarded by the host with a fixed warning, without logging raw peer
data or changing an otherwise valid helper result. Invalid core RPC framing still
fails normally. Real containment/cleanup failures retain their existing semantics
and do not discard an already collected snapshot.

## Interpretation limits

- The wall interval includes placement, helper execution and waiting, but not
  cgroup creation, output-drain completion, cleanup or result transport. It is
  wider than `archive_scheduler`; do not divide operation CPU by scheduler time.
  It is not `api_to_spawn` or team-concurrency queue time.
- Reads are sequential, not an atomic kernel snapshot. Forced cleanup can still
  have live descendants at this boundary; those counters are not final lifetime
  accounting. A disconnected or crashed guest cannot deliver a terminal summary;
  cleanup still runs on disconnect, but this evidence is unavailable. There is
  no serial fallback, retry, durable outbox or delayed logger. Missing summaries
  are not zero usage.
- Accumulated throttled time can exceed elapsed wall time. Do not subtract it
  from latency or advertise it as a removable saving.
- Configured leaf limits do not establish unconstrained ancestors or explain
  scheduler/accounting stalls. A later snapshot cannot reconstruct per-period
  CPU execution or a historical pause/resume trace.
- With `memory.high=max`, zero high events do not exclude guest-global reclaim.
  Peak/charged memory omits the timing of pressure and does not represent all
  shared pages accessed. Cgroup reclaim and fault counts do not measure all
  global allocation, writeback, host paging or balloon-related stalls.
- Compare exact Runner/API artifacts when analyzing frequently released,
  mixed-version production windows. Older versions have no summary. These
  internal storage-result format changes together with the bundled Runner/guest
  binaries, which are one deployed artifact. It changes no externally deployed
  API, queue, persisted state or resource policy. Do not pair a new Runner with
  old guest binaries; see [deployment compatibility](deployment-compatibility.md).

See the authoritative [cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [CPU bandwidth control](https://docs.kernel.org/scheduler/sched-bwc.html).
