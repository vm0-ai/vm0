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

- [macOS run 33960631686](https://github.com/vm0-ai/vm0/actions/runs/33960631686)
  for `e4928c2` passed 30 app/core tests and all 118 unchanged helper tests,
  release compilation, bundle signature/architecture checks, packaged launch,
  a native permission probe, and a settings-window screenshot. The PR check
  records the commit and download URL for each later successful build.
- Its app and independent project ZIPs were downloaded and integrity-checked.
  Desktop 0.46.17 contains four arm64 Mach-O executables and eleven notices;
  the project includes both pinned Swift packages and matches the tested source.
- A real HTTP regression reproduces an old claimed command completing after
  host revocation. The replacement registers only after that work drains; an
  old response cannot clear the replacement's credentials or state.
- macOS bootstrap tests load a corrupt preferences file while observing a real
  updater feed request. Real filesystem and launch-process tests verify rollback
  and relaunch of the previous bundle after replacement launch fails.
- An actual non-executable installer fails at Foundation `Process.run`; the
  updater restores the prepared model and never calls quit. This establishes
  installer-start failure recovery, not a Developer ID signed update acceptance.
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

Protected staging access is supplied only through an explicit preview-process
environment variable. HTTP tests verify the preview header/cookie, bearer,
origin restriction, and rejection of redirects; production origins reject the
preview credential. Real WebKit tests require that cookie before acknowledging
handoff. A macOS cookie probe exposed that a `secure` property with the string
`FALSE` still sets `isSecure`; HTTP fixture cookies now omit that property.
Anonymous startup skips account-only feature requests. A held real identity
request reproduces startup supersession; the unchanged assertion passed after
expected cancellation stopped becoming a visible application error.

The MCP producer/import review also restored baseline normalization: trim URL
and command, prefer a nonempty URL, otherwise use the command, retain only string
arguments/environment values, and keep imported servers disabled. The existing
real stdio and HTTP lifecycle tests exercise those inputs.

## Live macOS evidence and limits

The separate Computer Use connector previously returned 403, but the documented
staging Mac SSH/VNC workflow is accessible. After another build replaced the
shared Okou development installation, this walkthrough established a separate
`Zero CU Dev.app` installation on arm64 macOS 26.6.2. Its identity is
`ai.vm0.zero.desktop.dev`, version 0.46.17, built from `f0b3b92` in the extracted
independent project. The running executable SHA-256 is
`179bb351fa0b3faf70ff507fdf2dca0e57a636fe70f85f60a1b294a9d8e775a2`.
Subsequent test-only and startup-cancellation changes have CI evidence but have
not replaced that installation, preserving its current TCC identity.

The current staging Worker frontend maps to `staging-api.vm6.ai` and
`staging-www.omby.ai`. The actual API requires preview access; the native
environment-only credential and WebKit cookie support were added after its 403
was observed. A development-only Clerk account and organization were created
through the staging app onboarding UI. Real Clerk handoff tickets were received
by the packaged native application, its WebKit page acknowledged completion, and
the hosted handoff-status endpoint returned `completed`. The native UI showed
the account/workspace, and a normal Quit/LaunchServices restart restored the
session and gated features.

This is partial live authentication evidence. The normal hosted desktop login
form loses its factor route: `/desktop-auth/start/factor-two` returns a 308 to
`/desktop-auth/start`, leaving Clerk in `needs_second_factor` on the first form.
The same problem was observed in Mac Safari and a separate ordinary browser.
To prepare the native consumer test, the development OTP was completed through
the official Clerk SDK in that separate browser and its real handoff callback
was opened on the Mac. That preparation does not establish a successful
system-browser login walkthrough, automatic browser navigation, long-lived
renewal, or concurrent account changes.

The installed app was launched through LaunchServices so TCC identifies Zero,
not the SSH launcher. Visible Screen Recording consent, app restart, and the
additional direct-capture prompt resulted in a granted native permission state.
The picker listed actual displays/windows and rendered the dedicated TextEdit
test document correctly. Accessibility remains false in the helper despite its
System Settings switch being enabled. During the later picker walkthrough the
recording/plugin tabs disappeared on refresh; no recording helper or completed
video was present at inspection. The cause remains unconfirmed. Actual capture,
audio, upload, real app control, and TCC revocation are therefore still open.

## Feature inventory and evidence

| Existing behavior                                                                                | Native implementation                                                               | Acceptance still required                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Okou/Zero, production/development identities, macOS 14+, arm64                                   | `DesktopConfiguration`, packaging script                                            | Both product bundles, URL scheme registration, icon and permission identity               |
| System-browser login, handoff code, workspace selection, token renewal, sign-out, restore        | `DesktopAuth`, `DesktopAPI`                                                         | Live Clerk handoff and renewal after long captures; concurrent live account changes       |
| Host start/stop, registration, heartbeat, adaptive polling, retry, revoked credentials, draining | `HostRuntime`                                                                       | Live command round trip, competing hosts, and prolonged network recovery                  |
| Nine Computer Use capabilities and post-action screenshot/state                                  | `ComputerCommands`, unchanged native helper                                         | Live app action/foreground recovery acceptance and broader snapshot fixtures              |
| AX, screen capture, Chrome/Safari Automation permissions                                         | Native helper and `DesktopView`                                                     | TCC onboarding, grant changes while running, denied browser automation                    |
| Filesystem opt-in, selected directories, thirteen tools                                          | `FilesystemTools`, native settings                                                  | Concurrent filesystem changes and remaining platform-specific matching edges              |
| MCP JSON import, per-server opt-in, stdio/Streamable HTTP, tool discovery and binary results     | `MCPPlugins`, official Swift MCP SDK, `PluginResult`                                | Transport loss during calls, exhausted restart budget, and cancellation under load        |
| `_debug`, `computerUseDesktopPlugins`, `introVideo` feature switches                             | `DesktopModel`                                                                      | Live account changes and rapid feature withdrawal during capture/delivery                 |
| Menus, tray states, close-to-tray, Dock activation, confirmation on quit                         | `DesktopDelegate`, `DesktopActivation`                                              | Packaged second-launch UI walkthrough and complete menu/Dock behavior                     |
| Keep-awake preference and assertion cleanup                                                      | `DesktopModel`, IOKit                                                               | Sleep/display behavior and quit cleanup                                                   |
| Display/window/area capture; previews; secondary-display coordinates                             | `ScreenRecorder`, `AreaSelector`, unchanged recorder helper                         | Multi-display/Retina capture and area picker walkthrough                                  |
| System audio, macOS 15 microphone, pause/resume/discard, global stop shortcut, source loss       | `ScreenRecorder`, `RecordingController`, Carbon shortcut, unchanged recorder helper | Real audio/source loss, floating controls, and area capture without app UI                |
| Video and click-track upload, token renewal, retry, browser review handoff                       | `DesktopAPI`, `ScreenRecorder`                                                      | End-to-end delivery and account/workspace changes during upload                           |
| Logs and Sentry without screenshots/default PII                                                  | `HostRuntime`, `DesktopView`, Sentry Cocoa                                          | Native diagnostics walkthrough and actual Sentry event context (without capture contents) |
| Thirty-minute update check, idle deferral, verification, replacement and restart                 | `DesktopUpdater`, installer helper                                                  | Developer ID signed native upgrade and rollback; release promotion integration            |
| Build and download app/project from PR                                                           | `desktop-swift.yml`, build/archive scripts                                          | Verified; keep the PR download link on the newest successful build                        |

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
   including a real signed native update/rollback. The real installer-start failure
   test now passes; signed replacement remains unaccepted.
2. Complete live Clerk handoff and renewal on a stable native installation;
   exercise account/workspace changes during capture and active delivery.
3. Complete TCC onboarding/revocation, real app commands, multi-display/Retina
   selection, floating controls, system audio, microphone, source loss, and the
   complete upload/review handoff on both product identities.
4. Finish the remaining filesystem/MCP and menu/activation walkthroughs in the
   table. Automated fixtures and rendered windows do not establish actual
   capture, signed updates, or live end-to-end parity.

The current update producer intentionally retires Zero and legacy Okou feeds:
`desktop-updates.service.ts` publishes the primary Okou artifact and the route
returns 404 for retired product feeds. This review does not restore a retired
release line or authorize a release. The primary Okou Developer ID signed update,
rollback, and release-promotion integration still require acceptance.

## Completion gate

The PR is kept in draft while these acceptance items are open. A compiling app
and downloadable ZIPs do not prove full feature parity. The persistent goal
must remain active until the relevant tests and live macOS evidence establish
parity, or a concrete feasibility blocker is reported. Production release
promotion is not authorized by this PR request.
