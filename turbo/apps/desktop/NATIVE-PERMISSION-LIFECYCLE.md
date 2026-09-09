# Native permission query lifecycle

`ComputerUseNativeRuntimeClient` retains the correlated settlement owner until
status, result shape and permission fields are validated. Terminal protocol,
transport, timeout and process failures invalidate the backend, settle its
pending request and release queued callers with failures. A poisoned backend
cannot spawn another helper. Duplicate/unowned frames are ignored; output from
a retired process cannot make a new generation ready.

`ComputerUseRuntimeController.refreshNativePermissions` owns read-only refresh
recovery. A current, running Okou generation may recover only from the typed
`permissions.state` deadline: either the outer request timer or Swift's existing
`target_app_unresponsive` deadline response for that specific command. Other
native failures, malformed responses, actual permission denial and permission
requests do not retry. Startup and passive reads do not enable recovery.

Concurrent refreshes share their first read and one recovery episode. The
permission-provider lease is released before the existing replacement queue
waits for command completion, generation retirement and proven process exit.
The replacement gets exactly one new permission probe. The driver retains
snapshot and executor ownership: a claimed command fails/reports in its old
generation and never moves to the replacement. Fresh commands must observe
again. Failed retirement remains owned and blocks replacement.

The current lifecycle intent and opaque auth-session authority invalidate late
work. Stop, sign-out, workspace/session changes, driver selection, Quit,
update and caller cancellation revoke recovery. A cancellation or shorter
budget from any joined waiter cancels the shared episode; it cannot publish
readiness for another waiter. New work under a new intent cannot share an old
result. Explicit selection can perform its own authorized replacement after
superseding the obsolete recovery.

Graceful driver replacement and drain-and-stop cancel the probe's result while
the existing host owner drains healthy claimed actions through completion
reporting. They do not force-stop a healthy helper merely because a read was
concurrent. Revoked authority, explicit query cancellation and expired budgets
still withdraw readiness and force retirement; failed helpers remain poisoned.

## Bounds

- A helper request retains its 60-second backstop. Swift's semaphore policy is
  unchanged at 10 seconds.
- A refresh starts with a total monotonic cap of the existing 60-second attempt
  plus the existing 30-second transition bound: at most 90 seconds by default.
  The transition includes command drain, old-process cleanup and the one fresh
  probe; it does not give the probe another unconditional 60 seconds.
- Heartbeat passes its existing 10-second deadline and cancellation signal.
  Startup and explicit transitions keep their existing 30-second bounds.
  Claimed commands keep their own total execution and reporting budgets and
  never use automatic permission recovery.
- A shorter caller deadline wins. It is checked in continuations as well as
  timers, so delayed timer delivery cannot mint a fresh budget after resumption.
- Native disposal retains the existing three one-second EOF/TERM/KILL exit
  waits. Failure cleanup can remain owned for those three seconds after the
  caller-facing deadline (93 seconds for the default refresh plus cleanup).
  An unproven exit is a failure, never permission to overlap processes. Old
  command leases retain their independent, existing reporting lifetime.
- No timer guarantees progress while the parent process or OS is suspended.

## Diagnostics and evidence limits

Existing helper error reporting receives at most 12 phase entries per process:
spawn request, observed spawn, dispatch, response processing, timeout, protocol,
write and close. Elapsed values and timer overshoot clamp to 120 seconds. The
record contains request/process sequences, parent-observed helper age and known
exit state. Arbitrary serve-mode stderr is discarded; only a byte count capped
at 4096 is retained. No payload, typed text, app/screen contents, JSONL response
body, token or user identity is added. History belongs to its process, and query
listeners/timers are removed when their owner finishes.

A bounded recovery breadcrumb records generation, outcome and elapsed time.
Existing timeout, protocol, shutdown and unexpected-exit errors remain
reportable. There is no broad Sentry suppression or new monitoring service.

Swift receipt/completion markers and OS suspend/resume markers are absent and
therefore unknown. A response-processing timestamp is the parent's observation,
not a helper execution timestamp. Timer overshoot proves delayed timer delivery,
not macOS sleep or a blocked permission API. The production incident establishes
one outer timeout only; the two regressions do not establish its unique cause.

## Regression boundaries

The exported native backend tests cover correlated malformed status/result,
invalid permission fields, malformed JSON, non-object frames, duplicate and
unowned frames, queue settlement, teardown and diagnostic bounds/privacy.
Driver/runtime integration covers shared recovery, two failures, unproven exit,
Stop/auth/workspace/switch/Quit/update/cancellation, late old-process results,
caller deadlines, claimed-command completion and old snapshot rejection.

The parent-stall fixture runs the actual backend, driver, permissions, runtime
and host composition in an independent Node process. Filesystem notifications
synchronize a warmed helper and an independent coordinator. The helper proves
its JSONL write completed before the 400 ms attempt deadline; the coordinator
holds only that parent until the deadline has elapsed. Vitest itself never
stalls. The assertion requires fresh-generation readiness, not acceptance of
the stale buffered reply. This and the correlated settlement regressions fail
on unmodified pre-fix source.

Linux fixtures and CI do not establish signed-Mac/TCC, real permission dialogs,
real applications, or sleep/wake acceptance. No Swift, SDK or Electron version,
public API, database, default driver, UI layout or release behavior changes.
