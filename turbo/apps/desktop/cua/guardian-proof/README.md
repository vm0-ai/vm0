# Native lifecycle guardian proof gate

This is the Draft proof for #32650, not a working quit repair. The original
[utility-only experiment](https://github.com/vm0-ai/vm0/issues/32650#issuecomment-5584395113)
is retained unchanged. No production path loads these diagnostic files.

## Candidate process tree and ownership

1. Electron 42.5.1 main loads a first-party lifecycle-only Node-API module. It
   never imports CUA. The module uses `posix_spawn` with
   `POSIX_SPAWN_SETPGROUP`, group zero, to create a native guardian as the sole
   initial member and leader of a new group. Kernel parentage and group creation
   exist before any guardian instruction, SDK import or daemon spawn.
2. The guardian directly spawns the same bundled Electron executable in its
   supported `ELECTRON_RUN_AS_NODE` mode, with a fixed SDK entry and minimal
   environment. This SDK helper inherits the group. Only it imports the public
   CUA 0.23.2 SDK/EmbeddedCuaDriverHost. The host's daemon inherits that group.
3. Main owns the guardian directly through the native module, **not** a Node
   ChildProcess/libuv process handle. `waitid(WNOWAIT | WNOHANG | WEXITED)`
   observes its exit without reaping. The unreaped direct child reserves its PID
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
5. Main's monotonic five-second retirement deadline is armed before cleanup.
   Three seconds are available for graceful work, the remaining two for group
   SIGKILL and exit observation. A failed kill or missing observation produces
   `cleanup_unproven`, retaining the native child reservation and generation
   fence. No replacement/update is permitted. A syscall return is not evidence
   of exit.
6. Guardian independently watches a close-on-exec lifetime pipe from main and
   a heartbeat lease. Main death/lease expiry makes the still-live guardian
   signal its own group, including itself. Guardian failure is handled by main
   using the retained direct-child identity. No third unsupervised guardian,
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
