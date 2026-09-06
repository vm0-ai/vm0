# Runner reactor progress

The runner reactor (`crates/runner/src/cmd/start/mod.rs`) selects between
discovery, lifecycle changes, job completion, and maintenance. Some selected
branches await shared resources inline. Work that uses those same resources must
be able to progress independently of the reactor.

## A retained future is not an independent task

Keeping a future outside `tokio::select!` preserves its progress when another
branch wins, but only the reactor polls that future. This can deadlock even when
no mutex guard crosses an await:

1. A retained heartbeat future queues for the idle-pool mutex.
2. Another branch wins. Inline admission or drain queues for that mutex too.
3. The current holder releases the mutex. Tokio's FIFO mutex reserves progress
   for the heartbeat waiter.
4. The reactor is awaiting its own lock request, so it cannot poll the heartbeat
   waiter ahead of it. Other waiters, including finalizers, also stop progressing.

Status retry has the same dependency through the status-state mutex and ordered
persistence. The state-lock case does not require an earlier failed file write.
Persistence timeouts do not bound a wait that happens before persistence starts.

## Ownership and shutdown

| Work                       | Owner and progress rule                                                                                                                                                                                  | Shutdown                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat                  | One independently scheduled task; triggers coalesce into at most one pending request. The next send uses live state and lifecycle mode. Shared immutable configuration is allocated once per controller. | Natural drain flushes a Stopping snapshot. Common teardown joins the active send before provider shutdown. Abnormal controller drop aborts the task; dropping a client request does not retract a remote request, so snapshot generation/sequence fencing remains required.                                                       |
| Status retry               | One independently scheduled task. State generations, ordered persistence, and atomic-write continuation remain authoritative.                                                                            | Join the retry before final status publication. If the reactor itself is cancelled, the task retains ownership until it finishes.                                                                                                                                                                                                 |
| Routine workspace-cache GC | One independently scheduled task, with host-global cadence and exclusion enforced by the capacity lock.                                                                                                  | Join before dependent teardown. Do not abort the task during normal shutdown: filesystem deletion may outlive a dropped async future. If the reactor itself is cancelled, the task retains its locks through completion rather than releasing them over unfinished I/O. Process/runtime termination remains an abnormal boundary. |
| Poll wakeups               | Short synchronous mutex sections protect only in-memory scheduling state. No I/O, await, or long nested work is permitted under this lock.                                                               | Notification registration before state recheck, generation fencing, deferred-poll caps, and cancellation remain unchanged.                                                                                                                                                                                                        |

Task join failures stop the reactor through its existing lifecycle and common
teardown path and are returned as terminal errors. Ordinary optional GC or status
retry errors remain warnings. Runtime task ownership does not make an individual
filesystem or network operation infinitely fast or cancellation-safe.

## Other retained-work audit

- Discovery remains pinned across reactor turns: restarting it on each tick
  would reset polling timers and discard provider-local state. The direct inbox
  releases its batch lock before returning a candidate; inline batch updates
  follow a completed discovery. Claim cooldown updates have no shared retained
  lock holder that depends on the reactor to resume. PollWakeups is synchronous
  because both retained discovery and inline callbacks access its state.
- Workspace-cache watcher work remains retained with ownership of its watcher
  and drained filesystem events. Its classification does not own an idle-pool or
  status waiter needed by an inline reactor branch.
- Active-run and budget locks protect short synchronous state updates.
- Active/idle transfers and cancellation retain their existing ownership gates:
  contested gates are not awaited while holding the idle pool.

New branches must be checked against both lock holders and queued waiters. Do not
spawn discovery unconditionally or change admission/reuse policy to work around
resource ownership problems.

## Coverage and remaining incident work

`cmd/start/tests/main_loop/shared_resource_progress.rs` drives the real `run()`
entry point under forced pool, status-state, and persistence-ordering contention.
It also checks heartbeat-owner failure and GC progress/completion ownership.
Existing heartbeat tests cover coalescing, monotonic sequences, live-mode
follow-ups, and no overlapping requests; provider tests cover wakeup scheduling
and generation/defer semantics.

This is the reactor-progress slice [#32050](https://github.com/vm0-ai/vm0/issues/32050)
of [#32040](https://github.com/vm0-ai/vm0/issues/32040). Separate follow-ups track
[helper recovery and outstanding cleanup](https://github.com/vm0-ai/vm0/issues/32051),
[warn-only promotion drain diagnostics](https://github.com/vm0-ai/vm0/issues/32052),
and [live-runner metric filtering](https://github.com/vm0-ai/vm0/issues/32053).
These are not fixed by changing reactor task scheduling.
