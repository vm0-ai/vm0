# macOS Desktop rewrite acceptance

Baseline: `vm0-ai/vm0` main commit
`45d2e0f` (Desktop version `0.46.12`). The inventory is based on the actual
Desktop source, not the older overview in the Electron README.

## Feasibility

No product feature requires Electron. macOS Accessibility/CGEvent and
ScreenCaptureKit already run in Swift helper processes, so those implementations
and their tests can be reused without changing their protocol. The remaining
desktop ownership maps to SwiftUI/AppKit, WebKit authentication, Foundation
networking/processes, IOKit power assertions, and the official Swift MCP SDK.

## Verified automated evidence

- [macOS run 33951499997](https://github.com/vm0-ai/vm0/actions/runs/33951499997)
  for `a56a67d` passed 25 app/core tests and all 118 unchanged helper tests,
  release compilation, bundle signature/architecture checks, packaged launch,
  a native permission probe, and a settings-window screenshot. The PR check
  records the commit and download URL for each later successful build.
- A real HTTP regression reproduces an old claimed command completing after
  host revocation. The replacement registers only after that work drains; an
  old response cannot clear the replacement's credentials or state.
- macOS bootstrap tests load a corrupt preferences file while observing a real
  updater feed request. Real filesystem and launch-process tests verify rollback
  and relaunch of the previous bundle after replacement launch fails.
- Real child-process tests exercise malformed helper replies, ignored termination
  signals, descendant cleanup, timeout reaping, and MCP disable/re-enable and
  immediate-start cancellation. A new runtime waits for the old owner to exit.
- Cross-process file-lock tests establish one native instance per identity;
  macOS distributed-notification tests transfer callbacks through a private queue
  to the existing owner. Invalid snapshot identity and required fields cannot
  become later element targets. All nine Computer Use commands are exercised.
- Snapshot goldens contain seven baseline TypeScript outputs. Filesystem goldens
  contain 550 path/glob combinations and 69 edits, including exact jsdiff context,
  missing final newlines, range braces, whitespace matching, and dry runs.
  Integration tests also exercise grants, symlink escapes, partial reads,
  metadata, recursive search, and bounded head/tail reads from large files.
- macOS recording fixtures exercise pause/resume, failed discard and stop with
  continued polling, malformed recording metadata, upload retry, and forced
  process cleanup when recording availability is withdrawn. These use real
  processes, HTTP requests, and WebKit; they do not capture actual audio/video.

The authenticated Computer Use command returned **403: Computer Use is not
authorized for this run** on September 5. No real desktop was inspected or
operated. This environment limitation leaves live acceptance outstanding; it
does not prevent continuing the implementation and regression work.

## Feature inventory and evidence

| Existing behavior                                                                                | Native implementation                                        | Acceptance still required                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Okou/Zero, production/development identities, macOS 14+, arm64                                   | `DesktopConfiguration`, packaging script                     | Both product bundles, URL scheme registration, icon and permission identity         |
| System-browser login, handoff code, workspace selection, token renewal, sign-out, restore        | `DesktopAuth`, `DesktopAPI`                                  | Live Clerk handoff and renewal after long captures; cancel/late-completion races    |
| Host start/stop, registration, heartbeat, adaptive polling, retry, revoked credentials, draining | `HostRuntime`                                                | Live command round trip, competing hosts, and prolonged network recovery            |
| Nine Computer Use capabilities and post-action screenshot/state                                  | `ComputerCommands`, unchanged native helper                  | Live app action/foreground recovery acceptance and broader snapshot fixtures        |
| AX, screen capture, Chrome/Safari Automation permissions                                         | Native helper and `DesktopView`                              | TCC onboarding, grant changes while running, denied browser automation              |
| Filesystem opt-in, selected directories, thirteen tools                                          | `FilesystemTools`, native settings                           | Concurrent filesystem changes and remaining platform-specific matching edges        |
| MCP JSON import, per-server opt-in, stdio/Streamable HTTP, tool discovery and binary results     | `MCPPlugins`, official Swift MCP SDK, `PluginResult`         | Transport loss during calls, exhausted restart budget, and cancellation under load  |
| `_debug`, `computerUseDesktopPlugins`, `introVideo` feature switches                             | `DesktopModel`                                               | Broader concurrent refresh, account changes, and recording preparation races        |
| Menus, tray states, close-to-tray, Dock activation, confirmation on quit                         | `DesktopDelegate`, `DesktopActivation`                       | Packaged second-launch UI walkthrough and complete menu/Dock behavior               |
| Keep-awake preference and assertion cleanup                                                      | `DesktopModel`, IOKit                                        | Sleep/display behavior and quit cleanup                                             |
| Display/window/area capture; previews; secondary-display coordinates                             | `ScreenRecorder`, `AreaSelector`, unchanged recorder helper  | Multi-display/Retina capture and area picker walkthrough                            |
| System audio, macOS 15 microphone, pause/resume/discard, global stop shortcut, source loss       | `ScreenRecorder`, Carbon shortcut, unchanged recorder helper | Floating recorder controls, real audio/source loss, and area capture without app UI |
| Video and click-track upload, token renewal, retry, browser review handoff                       | `DesktopAPI`, `ScreenRecorder`                               | End-to-end delivery and account/workspace changes during upload                     |
| Logs and Sentry without screenshots/default PII                                                  | `DesktopView`, Sentry Cocoa                                  | Full developer-tools content, error context parity, and bounded log behavior        |
| Thirty-minute update check, idle deferral, verification, replacement and restart                 | `DesktopUpdater`, installer helper                           | Developer ID signed native upgrade and rollback; release promotion integration      |
| Build and download app/project from PR                                                           | `desktop-swift.yml`, build/archive scripts                   | Verified; keep the PR download link on the newest successful build                  |

## Remaining implementation review

The anchored self-review is
[review 5119963663](https://github.com/vm0-ai/vm0/pull/31838#pullrequestreview-5119963663).
Host-session ownership, bootstrap updater independence, required product/version,
effective feature switches, upload metadata, helper frames, native snapshots,
and the three cited oversized dispatch/update functions have been repaired.
The host/bootstrap coverage gaps now have boundary regressions. The full-parity
verdict remains open.

Continue with:

1. Authentication refresh-task ownership and cancel/late-completion races;
   account/workspace changes during capture and delivery.
2. Native floating recorder controls and placement outside a selected area;
   source-loss/poll-error recovery and rapid prepare/disable transitions.
3. Quit/update failure recovery after the model has started shutting down,
   diagnostic parity, and the remaining producer-owned permission/source fields.
4. Live macOS acceptance for every remaining item in the table, including both
   product identities and signed updates. Automated fixtures are not evidence
   of live Clerk, TCC grants, actual app control, or audio capture.

## Completion gate

The PR is kept in draft while these acceptance items are open. A compiling app
and downloadable ZIPs do not prove full feature parity. The persistent goal
must remain active until the relevant tests and live macOS evidence establish
parity, or a concrete feasibility blocker is reported. Production release
promotion is not authorized by this PR request.
