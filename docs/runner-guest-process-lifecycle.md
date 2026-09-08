# Runner Guest Process Lifecycle

This document is the provider-neutral map of every production child process in
the guest from sandbox boot through the Agent CLI and managed tools. It records
which boundary is allowed to select each process class, where the process runs,
and which owner proves completion and cleanup.

The four process classes are exhaustive:

- **sandbox service**: fixed image services that live for the sandbox lifetime;
- **bounded setup helper**: a fixed program selected by a typed guest handler;
- **contained workload**: user-influenced work in an operation-owned workload
  cgroup;
- **controlled Agent**: the Agent operation with authenticated runtime and tool
  placement capabilities.

Generic sandbox callers can request only contained workload or the one sealed
controlled Agent entry point. They cannot request guest-root execution,
bounded-helper placement, or an arbitrary containment policy.

## Process Map

| Process or operation                                                                                 | Class and selecting authority                                               | Input and trust boundary                                                                                                               | Placement and resource policy                                                                       | Completion and cleanup owner                                                                                                                                                        | Relationship to Agent start                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `guest-init` (PID 1)                                                                                 | Sandbox service selected by the guest image entry point                     | Fixed image program and boot configuration                                                                                             | Guest root; sandbox-lifetime VM policy                                                              | VM lifetime; PID 1 owns guest shutdown                                                                                                                                              | Required and serial before guest readiness                                                                                    |
| `guest-control-server`                                                                               | Sandbox service forked and supervised by `guest-init`                       | Fixed embedded binary and fixed service arguments                                                                                      | Guest root; sandbox-lifetime VM policy                                                              | `guest-init` supervision and VM lifetime                                                                                                                                            | Required and serial before host operations                                                                                    |
| DNS `getent ahostsv4`                                                                                | Bounded setup helper selected only by the typed DNS handler                 | Bounded hostname and deadline; no caller-selected program                                                                              | Guest root in an owned process group                                                                | Single-active DNS worker, operation guard, kill, and reap                                                                                                                           | Required for a fresh sandbox; serial before Agent start                                                                       |
| `guest-state-restore --restore-state`                                                                | Bounded setup helper selected only by the typed guest-state handler         | Typed time, entropy, and timezone request with a deadline                                                                              | Guest root in an owned process group                                                                | Single-active restore worker, operation guard, kill, and reap                                                                                                                       | Required state preparation; serial before Agent start                                                                         |
| `guest-write-file` single, batch, and private variants                                               | Bounded setup helper selected only by typed file handlers                   | Typed path/content request with handler validation and deadline                                                                        | Guest root in an owned process group                                                                | File worker, operation guard, kill, and reap                                                                                                                                        | Required when its prepared input exists; serial before Agent start                                                            |
| `guest-agent cleanup-codex-session` and its fixed shell helper                                       | Bounded setup helper selected only by `Sandbox::cleanup_codex_session`      | Canonical thread ID and matching relative rollout path; fixed Codex home, 16,384-entry scan budget, program, and environment           | Sandbox user in an owned process group                                                              | Exec worker and `ExecProcessContainment`; natural or forced cleanup kills and reaps the complete group                                                                              | Required only for an actually reused Codex sandbox; serial before restored history publication and Agent start                |
| Fresh workspace-drive mount helper                                                                   | Bounded setup helper selected only by `Sandbox::mount_workspace_drive`      | Empty request; the guest owns the fixed program, command, paths, device, identity, deadline, output policy, and mount-state validation | Guest root in an owned process group                                                                | Single-active mount worker, operation guard, output drains, kill, and reap                                                                                                          | Required only for a fresh sandbox; serial before Agent start                                                                  |
| Generic one-shot shell operations, including timezone, cleanup fallbacks, and verification fallbacks | Contained workload selected by `Sandbox::exec`                              | Caller command and environment are untrusted workload input                                                                            | Per-operation `workload` cgroup with the standard CPU, memory, PID, and OOM policy                  | Exec worker and `ExecProcessContainment`; terminal result or forced cleanup removes descendants and hierarchy                                                                       | Required or optional by caller; serial when part of preparation                                                               |
| `guest-storage-apply --manifest-stdin`                                                               | Contained workload selected only by the typed storage-manifest handler      | User-influenced manifest, download, extraction, cache, and filesystem work                                                             | Per-operation `workload` cgroup with the standard workload policy                                   | Storage worker, operation guard, output drains, and containment cleanup                                                                                                             | Required when storage preparation is requested; serial, with deferred background fill allowed only after Agent readiness      |
| Codex model-catalog prefetch                                                                         | Contained workload selected by ordinary `Sandbox::start_process`            | Fixed prefetch shell, but network response and process execution remain workload data                                                  | Per-operation `workload` cgroup; no Agent control or placement capability                           | Prefetch task owns process wait/cancel; guest exec worker owns containment cleanup                                                                                                  | Optional and deferrable; may run concurrently with later preparation and Agent start                                          |
| Agent wrapper shell and Guest Agent                                                                  | Controlled Agent selected only by `Sandbox::start_agent_process`            | Runner constructs the command/environment; the Agent subsequently handles user-controlled work                                         | Per-operation `control` cgroup; the outer containment owns the standard workload resource hierarchy | Runner owns the typed process handle, readiness timing, and mandatory control capability; guest control registry, placement brokers, exec worker, and containment own guest cleanup | Required final pre-spawn operation; `exec_started` records shell spawn and `exec_agent_ready` completes the typed Agent start |
| Agent CLI or Codex app server                                                                        | Controlled Agent child selected by the Guest Agent's typed CLI startup path | Framework-specific Agent input and user session data                                                                                   | `workload/runtime`, entered through an authenticated pre-exec placement descriptor                  | Guest Agent CLI owner plus outer Agent containment                                                                                                                                  | Required after wrapper startup; serial with CLI launch, then concurrent with supervision                                      |
| `guest-tool-exec` and its requested shell command                                                    | Controlled Agent child selected by the managed tool envelope                | Tool request and shell command are user/Agent influenced                                                                               | A unique `workload/tools/tool-N` leaf obtained from the authenticated placement broker              | Tool wrapper/process group plus tool-placement broker and outer Agent containment                                                                                                   | Optional, concurrent after Agent readiness, and independently completed                                                       |

Read, copy, and other protocol handlers that do not spawn a process are
not child-process rows. They still participate in their normal sandbox
operation ownership and quiesce rules.

## Controlled Topology

```text
vm0-exec-<guest-pid>-<sequence>-<id>/
├── control/                    Agent wrapper and Guest Agent
└── workload/
    ├── runtime/                CLI or Codex app server
    └── tools/
        ├── tool-1/             one managed tool process tree
        ├── tool-2/
        └── ...
```

The exec-start protocol carries the semantic role independently from
lifecycle and transport control. `Workload` selects ordinary workload
containment. `Agent` selects the controlled topology and requires supervised
lifecycle plus an enabled control sink. The bootstrap endpoint starts the
control and placement brokers; its presence is validated against the role but
does not select containment.

The wrapper and Guest Agent remain in `control`. The Guest Agent authenticates
to the workload placement endpoint, receives and adopts the runtime
`cgroup.procs` descriptor, and confirms adoption. The broker revalidates the
same UID and current `control` membership before emitting Agent readiness. The
Guest Agent places the CLI in `runtime` immediately before exec. Each managed
tool authenticates separately and receives a fresh `tool-N` descriptor.
Controlled processes deny process inspection across the boundary.

## Ownership and Reuse

All fixed helpers and workload operations hold operation guards. Agent
readiness keeps the exec operation, placement brokers, and containment owner
active, so reuse cannot quiesce or park during bootstrap. Reuse first fences
new operations, waits for active ownership to reach zero, and verifies that
the `vm0-exec` hierarchy is empty before parking. A terminal result does not
replace descendant cleanup: the operation's containment owner remains
responsible for graceful or forced cleanup and hierarchy removal.

Storage remains contained even though it has a typed entry point because its
download, extraction, cache, and filesystem work is user influenced. The DNS,
state, file, and fresh workspace-mount helpers use process groups at guest
root; reused Codex cleanup uses a process group as the sandbox user. Their
typed handlers select fixed programs, validate bounded inputs before
containment selection, enforce deadlines, and own kill/reap. The workspace
mount accepts no input and fixes its device, target, mount-info source, shell
helper, identity, output policy, and timeout; unlike storage, it cannot select
user-provided download or extraction work. Codex cleanup additionally fixes
the target home, scan budget, environment, and helper script while retaining
independent Runner validation of its path output. That authority is not
available through generic exec APIs, and generic cleanup and storage
operations retain workload cgroups.

## Optional Codex Prefetch Start Failures

Codex model-catalog prefetch is best-effort only while the sandbox remains safe
for later work. A start deadline before the frame-write boundary, safe local
validation/admission failure, or explicit guest start rejection can skip the
prefetch on the same sandbox. An ordinary write failure is classified at the
serialized writer boundary, independently of the request deadline: a failed
`write_all` may have emitted a partial frame and poisons the connection.

Possible partial writes and start deadlines during/after writing stop further
workspace, storage, and Agent preparation on that sandbox. Fresh preparation
destroys it and may retry once with prefetch disabled, only after cleanup is
confirmed. This consumes the existing shared preparation retry budget; uncertain
cleanup or an already-consumed retry prevents another attempt. A direct run on
an already-owned sandbox fails through its existing cleanup owner instead of
replacing the sandbox in place.

Ordinary write failures retain `start_failed` prefetch telemetry; typed request
deadlines retain `start_timed_out`. The original write cause remains available
for diagnostics. Error text or an I/O timeout kind alone does not determine
whether this is a request deadline or whether the sandbox can be reused.

## Agent Start Timing

Required Agent bootstrap files are written in connector-context, user-environment,
then run-payload order through the existing bounded private-file operation.
`runner_required_private_files_write` measures this entire operation, including
serialization and oversized sequential/chunked fallback. It is not a transaction:
any failure prevents Agent start, but earlier entries may already have been written.
A fitting batch shares one 30-second guest-helper budget and one 60-second request
deadline; fallback retains the existing deadline per transmitted request.

The former `runner_connector_account_context_write` event is no longer emitted.
For historical comparisons, sum that old interval and the old
`runner_required_private_files_write` interval per run before aggregating. Do not
compare the old two-file interval alone against the new three-file interval or
infer independent per-file wall-clock durations from the batch.

`runner_agent_start_process`, `runner_executor_start_to_spawn`,
`runner_claim_to_spawn`, and `api_to_spawn` retain their historical shell-spawn
boundary. Agent readiness is recorded separately by
`runner_agent_start_to_ready`, `runner_executor_start_to_agent_ready`,
`runner_claim_to_agent_ready`, and `api_to_agent_ready`. The bounded component
series are `runner_agent_containment_create`,
`runner_agent_placement_broker_setup`, `runner_agent_shell_spawn`, and
`runner_agent_bootstrap_ready_wait`. Fresh pre-spawn admission remains held
until the ready event rather than shell creation.

The production-path benchmark lives in
`.github/scripts/runner-behavior-process-containment.sh`. It submits the
deterministic mock CLI through the same-metal runner and Guest Agent path, then
measures fresh sandbox, workspace-cache reuse, and exact sandbox reuse samples
under one service profile. Set `AGENT_READY_BENCHMARK_SAMPLES` to choose the
sample count; the script retains bounded raw JSONL evidence and reports the
sample count, failures, and p50/p90/p95/p99 for the shell, ready, and component
timings.
