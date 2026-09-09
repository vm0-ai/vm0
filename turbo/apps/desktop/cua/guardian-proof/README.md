# Native lifecycle guardian proof gate

This is the process-boundary proof for #32650. The production implementation is
in the same repair PR; these diagnostic entries are never shipped. The original
[utility-only experiment](https://github.com/vm0-ai/vm0/issues/32650#issuecomment-5584395113)
is retained unchanged. No production path loads these diagnostic files.

## Candidate process tree and ownership

1. Electron 42.5.1 main loads a first-party lifecycle-only Node-API module. It
   never imports CUA. The module uses `posix_spawn` with
   `POSIX_SPAWN_SETPGROUP`, group zero, to create a native guardian as the sole
   initial member and leader of a new group. Kernel parentage and group creation
   exist before any guardian instruction, SDK import or daemon spawn.
2. The single-threaded guardian forks a native bootstrap child into that group,
   blocked on a private gate. The guardian moves itself back to main's group
   using `setpgid`, retaining its live PID while leaving the kill target. Only
   after the move succeeds does it permit the child to exec the bundled Electron
   executable in `ELECTRON_RUN_AS_NODE` mode, with a fixed SDK entry and minimal
   environment. Only that helper imports the public CUA 0.23.2 SDK/host. If the
   move fails (including main's group disappearing), the gate stays closed and
   the guardian terminates/reaps its direct native bootstrap child; no SDK runs.
3. Main owns the guardian directly through the native module, **not** a Node
   ChildProcess/libuv process handle. `waitid(WNOWAIT | WNOHANG | WEXITED)`
   observes exit without reaping; only `CLD_EXITED`, `CLD_KILLED` and
   `CLD_DUMPED` count. Darwin can also report `CLD_STOPPED` under these flags.
   The unreaped direct child reserves its PID
   even after guardian failure. Main never sends a signal using a persisted PID
   or a caller-provided group number. It must retain this reservation until the
   group's other members have exited. Pinned Node 24.17.0 libuv waits only for
   its registered `uv_process_t` PIDs; the guardian is not registered there.
4. Guardian reaps its direct SDK helper. The public SDK normally reaps its own
   daemon. Forced/orphaned descendants are reaped by the OS. On macOS the
   candidate completion proof combines a retained guardian exit with a bounded
   `proc_listpgrppids` query proving no remaining group members; the test also
   independently registers `EVFILT_PROC/NOTE_EXIT` before each injected fault.
   Group enumeration errors, overflow or missing waitable identity fail closed.
5. Main can also signal its exact still-waitable guardian PID, after Darwin
   reports that all group members have exited. A stopped guardian can retain a
   zombie helper: `PROC_PIDTBSDINFO` must report the same reserved group/PID and
   `SZOMB` for every remaining member before main terminates the guardian.
   Failed status/identity reads retain the fence. This preserves the guardian
   if main dies while force is still reclaiming live SDK descendants. Main then
   retains the guardian zombie until the group is completely empty.

   For an explicitly stopped, exactly retained guardian, main sends `SIGCONT`
   so the lifecycle owner can reap its exited child. This handles the macOS
   SIGSTOP case without destroying supervision or treating a remaining zombie
   as an empty group. Failure to continue still retains the fence.

   Main's monotonic five-second retirement deadline is armed before cleanup.
   Three seconds are available for graceful work, the remaining two for group
   SIGKILL and exit observation. Signals repeat while the reserved group still
   contains members: macOS testing proved a spawn already inside the kernel can
   survive a single group signal. A failed kill or missing observation produces
   `cleanup_unproven`, retaining the native child reservation and generation
   fence. No replacement/update is permitted. A syscall return is not evidence
   of exit.

6. Guardian independently watches a close-on-exec lifetime pipe from main and
   a heartbeat lease. Main death/lease expiry makes the still-live guardian
   repeatedly signal the reserved group from outside it, observe group emptiness
   and reap its SDK helper, then exit. Guardian failure is handled by main using
   the retained direct-child identity. The guardian never voluntarily exits
   while descendants remain. No third unsupervised guardian,
   LaunchAgent, privileges, responsibility disclaimer or new entitlement is
   introduced. This covers individual main, guardian and helper faults; it does
   not claim a kernel guarantee under simultaneous destruction of both owners.

## Invariants to decide on macOS

- Darwin supports non-reaping wait observation and the direct-child identity is
  still waitable after repeated event-loop turns following guardian death.
- Group creation is established before the SDK executes; helper/daemon remain
  members during the before-ready window. Main and unrelated sentinel processes
  are outside the target. Application launch via the pinned macOS CUA
  `NSWorkspace` boundary must be inspected before production adoption.
- Both graceful and forced paths require actual independent exit observations;
  guardian exit alone is insufficient. Main remains responsive and observes its
  original total budget even if the helper cannot execute JavaScript.
- Main death, guardian death, helper death, startup-before-ready, repeated launch,
  failed kill, withheld observations and identity mismatch must be tested.
- No SDK-owned descendant may escape the group. If the supported process API or
  pinned launcher violates this invariant, this candidate cannot ship.

The first-party native module is an additional signed native-code inventory
entry if this proof succeeds. It performs bounded process syscalls only, never
CUA, UBRN or UniFFI calls. Product integration, fixed-path validation, typed RPC,
all retirement callers and three actual package lanes remain required before
Ready or merge. Ad-hoc CI does not establish Developer ID/TCC persistence.

The daemon fixture has a test-only self-expiry. The helper's deliberate
`Atomics.wait` also has a test-only expiry. These prevent failed experiments
leaving permanent processes; expiry is outside the five-second assertion and
can never count as successful retirement. These fixtures neither reproduce the
original native mutex race nor exercise user applications or permissions.

## Product integration under the Draft fence

The proof now compiles `native/cua-supervisor/{owner,guardian}.c`, the same
lifecycle implementation shipped in `Resources/native`. The test-only guardian
crash method is excluded from the packaged Node-API module. The production
heartbeat lease is five seconds; main death also closes the lifetime pipe.

`cua-sdk-process.js` is a separate bundled entry alongside those two binaries.
It exclusively loads the verified upstream payload in `Resources/cua`; the
upstream archive inventory and all three 0.23.2 pins stay unchanged. No system
Node is needed at runtime. The guardian execs the bundled Electron binary in its
existing RunAsNode mode and does not disclaim responsibility. The added nested
native code uses the existing signing policy and entitlements.

Main's `CuaProcessOwner` exposes only the fixed host/client/session lifecycle and
existing adapter methods over a private mode-0700 Unix socket. Requests carry
monotonic generation/request IDs and an absolute monotonic execution deadline.
Both sides cap frames and pending work; malformed replies, foreign generations,
disconnects and backpressure fail admission. The SDK MCP launcher environment is
never forwarded. Cancellation is an RPC message: no main callback enters CUA.
Quit, update and every driver retirement retain their shared cleanup fence until
the native owner independently observes guardian exit and group emptiness.

Each default, production-configuration and PR-preview package runs dormant
startup, healthy public embedded lifecycle, and a separate forced lifecycle.
The forced probe blocks actual helper execution with `Atomics.wait` before
native stop and requires process exit, a responsive main heartbeat, and
completion within the original five-second total budget. It is enabled only by
the dedicated package probe entry, never by renderer or agent commands. Reports
keep native graceful success distinct from proven forced reclamation.

The pinned CUA macOS application launcher calls NSWorkspace for user apps;
these launches are not forked SDK descendants. Its short-lived plist/process
inspection children inherit the reserved group. The lifecycle proof does not
operate a browser, recorder, plugin or user application.

The macOS proof at PR head `c33c686aaef1437389cdcdd650daf3e7a39a3232`
passed 25 cases in [run 34224326554](https://github.com/vm0-ai/vm0/actions/runs/34224326554).
This includes actual CUA 0.23.2 healthy and pending-metadata cancellation stress,
plus independent kqueue exits for observed processes. One stress case required
force; it is not a demonstrated reproduction of the original native mutex race.
The complete product integration and changed production source must pass again
at the final head. Draft status remains until those gates pass. Developer ID
attribution, TCC grant persistence and interactive user-Mac acceptance remain
pending; the fixture and ad-hoc CI cannot establish them.

The expanded 27-case production-source proof passed at
`d7c4524ad36bcfd06fe94a1cd7caa747c1b0f638` in
[run 34232446213](https://github.com/vm0-ai/vm0/actions/runs/34232446213).
`results.json` SHA-256 is
`5f7b9e79f0014b27019389b5c215c2ab42d803cd96f5923d623370ae4cbe08dc`.
The formerly failing guardian-stop case completed in 3038.38 ms with 258 main
heartbeats and independent kernel exits. Failed-force/identity/observation cases
retained their failure fences; their later diagnostic rescue is not successful
product cleanup. Ten immediate spawn/stop cases use native reservation/group
evidence; the other cases additionally register external kqueue exit observers.

`build-adapter.mjs` separately bundles the production adapter, process owner and
SDK helper. Its generated payload substitutes only the public SDK boundary with
the existing test fixture. It executes all nine commands, confirms readable
observation/action results survive the typed channel, verifies Cancel preserves
the current generation, and confirms coalesced Quit retires it. It uses actual
Electron/native guardian/socket transport, no CUA native or real applications.
Its `adapter.json` is distinct from the real-native `results.json` proof.
