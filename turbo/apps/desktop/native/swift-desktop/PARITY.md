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

- The macOS run for `5e8e3c4` passed the native app's nine tests, including a real
  stdio MCP process crash/restart, Streamable HTTP MCP requests, and WebKit token
  refresh with an unchanged token. The unchanged helper package passed all 118 tests.
- The packaged application launched, answered a native permission probe, and
  rendered its native settings window. The app and independent project ZIPs were
  downloaded and inspected; the app executable is arm64 Mach-O and all three
  helpers are included.
- Core tests now cover all nine Computer Use commands, post-action state,
  coordinate/index targeting, stale snapshots after helper restart, and failed
  permission probes still completing claimed host commands.
- Snapshot goldens contain seven outputs generated from the baseline TypeScript.
  Filesystem goldens contain 414 path/glob combinations and six editing cases
  generated from the pinned filesystem server and minimatch. Integration tests
  cover partial file reads, directory grants, symlink escapes, recursive search,
  metadata, and bounded head/tail reads from large files.

These fixtures verify protocol and orchestration behavior, not real TCC grants,
actual app control, audio capture, or a production Clerk session.

## Feature inventory and evidence

| Existing behavior                                                                                | Native implementation                                        | Acceptance still required                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Okou/Zero, production/development identities, macOS 14+, arm64                                   | `DesktopConfiguration`, packaging script                     | Both product bundles, URL scheme registration, icon and permission identity        |
| System-browser login, handoff code, workspace selection, token renewal, sign-out, restore        | `DesktopAuth`, `DesktopAPI`                                  | Live Clerk handoff and renewal after long captures; cancel/late-completion races   |
| Host start/stop, registration, heartbeat, adaptive polling, retry, revoked credentials, draining | `HostRuntime`                                                | Live command round trip, competing hosts, and prolonged network recovery           |
| Nine Computer Use capabilities and post-action screenshot/state                                  | `ComputerCommands`, unchanged native helper                  | Live app action/foreground recovery acceptance and broader snapshot fixtures       |
| AX, screen capture, Chrome/Safari Automation permissions                                         | Native helper and `DesktopView`                              | TCC onboarding, grant changes while running, denied browser automation             |
| Filesystem opt-in, selected directories, thirteen tools                                          | `FilesystemTools`, native settings                           | Broader glob syntax and exact diff presentation; concurrent filesystem changes     |
| MCP JSON import, per-server opt-in, stdio/Streamable HTTP, tool discovery and binary results     | `MCPPlugins`, official Swift MCP SDK, `PluginResult`         | Transport loss during calls, exhausted restart budget, and cancellation under load |
| `_debug`, `computerUseDesktopPlugins`, `introVideo` feature switches                             | `DesktopModel`                                               | Disable/refresh while commands or recording are in progress                        |
| Menus, tray states, close-to-tray, Dock activation, confirmation on quit                         | `DesktopDelegate`                                            | Native UI walkthrough and single-instance launch                                   |
| Keep-awake preference and assertion cleanup                                                      | `DesktopModel`, IOKit                                        | Sleep/display behavior and quit cleanup                                            |
| Display/window/area capture; previews; secondary-display coordinates                             | `ScreenRecorder`, `AreaSelector`, unchanged recorder helper  | Multi-display/Retina capture and area picker walkthrough                           |
| System audio, macOS 15 microphone, pause/resume/discard, global stop shortcut, source loss       | `ScreenRecorder`, Carbon shortcut, unchanged recorder helper | Real capture with audio and source disappearance; no controls inside output        |
| Video and click-track upload, token renewal, retry, browser review handoff                       | `DesktopAPI`, `ScreenRecorder`                               | End-to-end delivery and account/workspace changes during upload                    |
| Logs and Sentry without screenshots/default PII                                                  | `DesktopView`, Sentry Cocoa                                  | Error context parity, diagnostic visibility and bounded log behavior               |
| Thirty-minute update check, idle deferral, verification, replacement and restart                 | `DesktopUpdater`, installer helper                           | Signed native upgrade and rollback; release promotion integration                  |
| Build and download app/project from PR                                                           | `desktop-swift.yml`, build/archive scripts                   | Verified; keep the PR download link on the newest successful build                 |

## Completion gate

The PR is kept in draft while these acceptance items are open. A compiling app
and downloadable ZIPs do not prove full feature parity. The persistent goal
must remain active until the relevant tests and live macOS evidence establish
parity, or a concrete feasibility blocker is reported. Production release
promotion is not authorized by this PR request.
