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

- [macOS run 33954326712](https://github.com/vm0-ai/vm0/actions/runs/33954326712)
  for `e958e0d` passed 26 app/core tests and all 118 unchanged helper tests,
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

Additional boundary regressions cover expired recording credentials, cancelled
and superseded WebKit requests, account changes before delivery, late feature
switch responses after sign-out, malformed TCC/source/capability replies, stale
source loading, cancellation during preparation, source loss with a failed first
finalization, and recovery after a cancelled quit or workspace switch. The PR's
native check is the authority for their result on each subsequent commit.

## Live macOS evidence and limits

On September 5 the Computer Use connector returned **403: Computer Use is not
authorized for this run**. The separately configured staging Mac was subsequently
accessible through its documented SSH/VNC workflow. The verified `3eec82a` app
ZIP was installed and launched on that arm64 macOS 26.6.2 host. The native app
opened its settings window, and after the visible TCC grant/restart sequence it
reported Screen Recording as granted. Accessibility was still reported as
ungranted, and anonymous WebKit session restoration timed out. This establishes
packaged launch and a screen-permission transition, not successful authentication
or Computer Use acceptance.

The installed app was then replaced during the walkthrough: its executable
changed from this PR's `okou-desktop` to `Okou Dev`, with a different settings UI.
Testing on that shared desktop stopped to avoid attributing another build's
behavior to this PR. The remaining live checks need a stable, identified test
installation. The current staging Worker frontend origin is also now supported
by the native API/auth origin resolver; that configuration has not yet undergone
a live Clerk handoff.

The anonymous token-page stall also reproduces in a separate ordinary browser:
Clerk reports loaded with a null session while the page remains on its handoff
spinner. Native restoration now recognizes that state, and interactive WebKit
windows are visible so consent and error pages can be resolved. Receiving a
token no longer closes WebKit before the page can complete its server-side
browser handoff; a real HTTP barrier regression holds that acknowledgement
before allowing the final navigation. This repair still requires a live
authenticated Clerk walkthrough on the packaged native build.

## Feature inventory and evidence

| Existing behavior                                                                                | Native implementation                                        | Acceptance still required                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Okou/Zero, production/development identities, macOS 14+, arm64                                   | `DesktopConfiguration`, packaging script                     | Both product bundles, URL scheme registration, icon and permission identity         |
| System-browser login, handoff code, workspace selection, token renewal, sign-out, restore        | `DesktopAuth`, `DesktopAPI`                                  | Live Clerk handoff and renewal after long captures; concurrent live account changes    |
| Host start/stop, registration, heartbeat, adaptive polling, retry, revoked credentials, draining | `HostRuntime`                                                | Live command round trip, competing hosts, and prolonged network recovery            |
| Nine Computer Use capabilities and post-action screenshot/state                                  | `ComputerCommands`, unchanged native helper                  | Live app action/foreground recovery acceptance and broader snapshot fixtures        |
| AX, screen capture, Chrome/Safari Automation permissions                                         | Native helper and `DesktopView`                              | TCC onboarding, grant changes while running, denied browser automation              |
| Filesystem opt-in, selected directories, thirteen tools                                          | `FilesystemTools`, native settings                           | Concurrent filesystem changes and remaining platform-specific matching edges        |
| MCP JSON import, per-server opt-in, stdio/Streamable HTTP, tool discovery and binary results     | `MCPPlugins`, official Swift MCP SDK, `PluginResult`         | Transport loss during calls, exhausted restart budget, and cancellation under load  |
| `_debug`, `computerUseDesktopPlugins`, `introVideo` feature switches                             | `DesktopModel`                                               | Live account changes and rapid feature withdrawal during capture/delivery        |
| Menus, tray states, close-to-tray, Dock activation, confirmation on quit                         | `DesktopDelegate`, `DesktopActivation`                       | Packaged second-launch UI walkthrough and complete menu/Dock behavior               |
| Keep-awake preference and assertion cleanup                                                      | `DesktopModel`, IOKit                                        | Sleep/display behavior and quit cleanup                                             |
| Display/window/area capture; previews; secondary-display coordinates                             | `ScreenRecorder`, `AreaSelector`, unchanged recorder helper  | Multi-display/Retina capture and area picker walkthrough                            |
| System audio, macOS 15 microphone, pause/resume/discard, global stop shortcut, source loss       | `ScreenRecorder`, `RecordingController`, Carbon shortcut, unchanged recorder helper | Real audio/source loss, floating controls, and area capture without app UI |
| Video and click-track upload, token renewal, retry, browser review handoff                       | `DesktopAPI`, `ScreenRecorder`                               | End-to-end delivery and account/workspace changes during upload                     |
| Logs and Sentry without screenshots/default PII                                                  | `HostRuntime`, `DesktopView`, Sentry Cocoa                                  | Native diagnostics walkthrough and actual Sentry event context (without capture contents)        |
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

1. Review the new authentication/account-change, recording lifecycle, typed
   permission/source decoding, and diagnostic changes against their latest CI
   evidence. Confirm the updater can recover after installer startup failure,
   including a real signed native update/rollback.
2. Complete live Clerk handoff and renewal on a stable native installation;
   exercise account/workspace changes during capture and active delivery.
3. Complete TCC onboarding/revocation, real app commands, multi-display/Retina
   selection, floating controls, system audio, microphone, source loss, and the
   complete upload/review handoff on both product identities.
4. Finish the remaining filesystem/MCP and menu/activation walkthroughs in the
   table. Automated fixtures and rendered windows do not establish actual
   capture, signed updates, or live end-to-end parity.

## Completion gate

The PR is kept in draft while these acceptance items are open. A compiling app
and downloadable ZIPs do not prove full feature parity. The persistent goal
must remain active until the relevant tests and live macOS evidence establish
parity, or a concrete feasibility blocker is reported. Production release
promotion is not authorized by this PR request.
