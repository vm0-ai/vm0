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

- [macOS run 33970705573](https://github.com/vm0-ai/vm0/actions/runs/33970705573)
  for `c6b5c4a12` passed 31 app/core tests and all 121 helper tests,
  release compilation, bundle signature/architecture checks, packaged launch,
  a native permission probe, and a settings-window screenshot. The PR check
  records the commit and download URL for each later successful build.
- Its app and independent project ZIPs were downloaded and integrity-checked.
  Desktop 0.46.19 contains four arm64 Mach-O executables and eleven notices;
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
The app and recording links also renew preview access in the external browser,
whose cookie store is separate from WebKit and whose preview cookie expires after
one hour. A fresh HTTP browser request verifies both access and preserved
recording parameters; production links contain no preview credential.
Anonymous startup skips account-only feature requests. A held real identity
request reproduces startup supersession; the unchanged assertion passed after
expected cancellation stopped becoming a visible application error.

A further real HTTP/WebKit regression expires a token between the account and
workspace requests and renews it into another session. Before the repair the UI
combined the previous user with the new workspace. Identity refresh now pins one
bearer, retries the complete pair after a 401, and validates the required account
fields and matching workspace ID before publishing either response. Missing or
deleted workspaces still retain a signed-in account without a selected workspace.
The unchanged regression and all 31 app/core tests pass on the staging Mac.

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
Subsequent authentication and preview-access changes have CI evidence but have
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
test document correctly. Accessibility initially remained false despite an enabled System Settings
switch. Removing only the Zero entry and adding the exact current application
restored the helper's granted state without restarting the process; the native
UI then reported ready to connect. This verifies recovery of that consent
record, not general grant/revocation coverage.
During the later picker walkthrough the
recording/plugin tabs disappeared on refresh; no completed video was present at
inspection. A subsequent walkthrough observed the same account's actual feature
API return empty overrides and disabled effective switches, while the Lab UI
temporarily retained its earlier checked state. Re-enabling the switches through
Lab restored the API values and native tabs. The staging deployment log for
run `33962858999`, job `101298336923`, records the shared `preview/staging`
database resetting at 2026-09-05 11:22:04 UTC during this walkthrough. This
establishes an environment reset during acceptance; it does not attribute every
earlier disappearance to that cause.

After restoring the switch, this same installed package recorded the dedicated
TextEdit window with system audio and microphone disabled. Native floating
controls paused at 01:02, resumed, and stopped the take. The downloaded H.264
file contains one video track and no audio tracks, is 3,621,871 bytes, and lasts
99.69 seconds at 1346×878. Its click track records a 673×439-point window at scale
2 and excludes three out-of-frame control clicks. The actual frame was inspected
and the entire file decoded without errors using its original 1/600 time base.
Default null-output conversion rounded timestamps and warned about duplicate
DTS; the source has strictly increasing DTS and no duplicate PTS/DTS.

Delivery opened Safari, which was signed out. Normal app login through email,
password, and the development OTP reached the sign-in-complete screen, but the
next page stalled and a later navigation returned to sign-in. Browser session
persistence and final review remain unaccepted. This is separate from the hosted
desktop login factor-route problem above. Audio, multi-display/area capture,
source loss, full upload/review, and TCC revocation remain open.

The same installed package subsequently executed real staging API commands
against the dedicated TextEdit document. Eight command kinds completed API/helper
round trips: app listing/state/open, coordinate click, value assignment, an AX
action, text typing, and key presses. Post-action AX state confirmed typed and
assigned text; downloaded window-only screenshots show the actual changed
document. Background input preserved the native Desktop as the frontmost app.
An unsupported element click returned an explicit error; a coordinate click on
the same text area worked. This is not cold-launch or general foreground-recovery
acceptance.

**Reproduced baseline failure: `element.scroll` silently does nothing.** One-page and two-page
requests reported success, but the TextEdit scrollbar remained at zero and the
downloaded before/after images were identical. The unchanged helper's
`handleScrollElement` compares child roles against `AXVerticalScrollBar` or
`AXHorizontalScrollBar`, which are attribute names rather than scrollbar roles,
then returns success when it finds no match. Calling the advertised
`AXScrollDownByPage` action directly also failed with `-25205` on this TextEdit
scroll area.

A separate native acceptance app (`ai.vm0.swift-desktop.acceptance`) now runs
the actual helper JSONL protocol with its own visibly granted Accessibility and
Screen Recording permissions, preserving the installed Zero bundle. Its baseline
helper reproduced the unchanged TextEdit content position and zero scroll value.
The repaired helper resolves the axis through the proper AX attribute and presses
the scrollbar's native increment/decrement page button. It waits for animation
to settle before issuing another page or reporting the final position. A missing
bar, invalid input, or action that fails to move is an error.
An already reached boundary reports zero completed pages and `atBoundary: true`.

Real TextEdit window 1140 moved 374 points for one page, 748 for two more, and
374 back up. The scrollbar values were 0, 0.188698, 0.566095, and 0.377397;
window-only images show the corresponding text. Bottom/top clamping, repeated
boundary requests, and finding the scroll area from its text child also passed.
The acceptance app remained frontmost throughout. The repaired debug helper's
SHA-256 is `e76baaa867eff83d21c22b0b18b432d82003027b3bc17638598c3bb755c7f630`.
All 121 helper tests passed, including actual process/protocol input regressions.
[Window comparison](https://cdn.vm0.io/artifacts/mwbqq0j6ce.png) and
[sanitized command/state evidence](https://cdn.vm0.io/artifacts/gjqeu8vfpr.json)
record the baseline and candidate attribution.

A further 2000-line TextEdit test exposed the outer helper executor returning its
10-second timeout while its queue continued issuing page actions. An independent
AX observer measured another 2244 points of movement after the error. Scrolling
now owns an earlier deadline, reserving time for an AX reply and animation settling,
and checks it again immediately before each page action. The repaired command
returned its explicit time-limit error in 8.14 seconds including transport;
successive settled snapshots remained at the same position, and the next single
page completed in 1.38 seconds. All 121 helper tests also passed on the Mac.
The downloaded `c36b282` release helper subsequently passed the same live test:
8.49 seconds to the explicit error, identical settled positions afterward, and
1.36 seconds for the next page. Its SHA-256 is
`209ee6ea63fc11ecf08a2b165b5dd7758fe24508f660f17e055aa40e1bb6b9a8`.
[Release timeout evidence](https://cdn.vm0.io/artifacts/kohyh4dksq.json).

Fractional pages now use a pixel wheel event addressed to the target process and
window, with distance measured from the scroll area's visible extent. The same
path handles scrollbars without native page buttons. Whole pages retain their
native page action when available, including the application's overlap; a 1.5-page
request then adds half of the visible extent. Position and direction are verified
after each action, and the response identifies the actual dispatch method.

Live TextEdit half-page requests moved 204 points down and back up; 1.5 pages moved
578 points. Preview half pages moved 588 horizontal and 435 vertical points.
Safari's owned HTML page exposed scrollbars with no native page buttons: one page
moved 850 points, half a page moved 425 vertically and 662 horizontally, and 1.5
pages moved 1275 points. [Window comparisons](https://cdn.vm0.io/artifacts/r5wj9te5nd.png)
and [initial cross-app evidence](https://cdn.vm0.io/artifacts/97q1u8k3da.json).

An additional nested Safari page exposed a candidate dispatch bug: an event at the
outer area's center moved the inner list 425 points, leaving the outer scrollbar
unchanged and returning an error. The final implementation addresses the target
scrollbar's rail within the viewport. A real retest moved the outer page 425 points
while preserving the inner list's relative offset. Eight further background
commands across TextEdit, Preview, and Safari all preserved the acceptance app as
frontmost without restoration. The final debug helper SHA-256 is
`ac4f21b0414c02db5e184109926ab0f7f5f3433d2c2deff36a11893d5aff29cb`;
all 121 helper tests passed. The first earlier Preview half-page command needed
frontmost restoration; that remains recorded in the initial evidence.
[Final candidate and nested-target evidence](https://cdn.vm0.io/artifacts/wiu49jyt34.json).

The downloaded `27cdeb1` release helper repeated all eight cross-app background
commands successfully, with the expected wheel/mixed dispatch metadata. It also
passed the nested Safari test: the outer page moved 425 points while the inner
offset remained -301 points. A 1000-page request returned the explicit time-limit
error in 8.15 seconds; two settled snapshots remained at y=-15026, and the next
page completed in 1.37 seconds. The release helper's SHA-256 is
`987b2653bca53aac7ef208f25f87455824798975762cbcd6e0cd47e4e18c3692`.
Both CI ZIPs were downloaded and checked, including all 102 source inputs and
84 Swift files, both dependency lockfiles, all four arm64 executables, and eleven
dependency notices. CI passed 31 app/core tests and 121 helper tests.
[Downloaded release acceptance](https://cdn.vm0.io/artifacts/ja1li8sllt.json).

These are real release helper tests, not a new packaged Desktop/server round trip.
Targets without an AX axis scrollbar, including unexposed nested web containers,
and broader application coverage remain open.
The old installed `f0b3b92` Desktop remains unchanged;
do not mark all nine authenticated Desktop command kinds accepted from this test.

The same repaired helper also scrolled an owned 3200-by-2400 grid in Preview at
Actual Size (window 1245). A right page reached the horizontal boundary; a left
page moved 1129 points. A down page reached the vertical boundary; an up page
moved 840 points. AX image bounds and window images agree. The first right command
observed an unrelated frontmost-app change from the acceptance app to Safari;
its cause is not established, so that command is not foreground-preservation
evidence. The subsequent left/down/up commands preserved Safari as frontmost.
[Preview command/state evidence](https://cdn.vm0.io/artifacts/f2x9wj7mnq.json)
records this separate application test. Broader target coverage remains open.

A second shared staging deployment (run `33965940210`, job `101306017261`)
reset `preview/staging` at 12:25:32 UTC. The native poll received 401 and returned
to ready; the user API listed no linked host. Reconnecting registered a new host
and real commands resumed. This does not establish general network recovery.

The actual keep-awake switch created a `PreventUserIdleDisplaySleep` assertion
owned by the identified native process; switching it off released that assertion.
Closing the settings window left the host online, and LaunchServices reopened
the window in the existing process. The test document was restored with native
commands and saved, then verified byte-for-byte against its original contents.
Sleep behavior, quit cleanup, and the remaining menu/Dock interactions are open.

### Keyboard shortcut acceptance

The downloaded `d8e5159` helper reported successful background Command-W in
Safari without closing the owned tab. This was reproduced again after dismissing
the acceptance app's own screen-capture consent and crash dialogs. The repair
recognizes Safari's standard menu equivalent and performs its selected native
tab's close action in the resolved target window. It verifies that the original
tab leaves its parent before reporting success and does not retry with a key
after an uncertain close. Other shortcuts retain their keyboard event path.

The candidate closed only the owned tab, reducing the window from 12 tabs to 11,
with the acceptance app remaining frontmost. The `on-window-unavailable` policy
did the same; explicit `always` recovery activated Safari and closed the owned
tab. Metadata identifies the actual accessibility dispatch. System-wide AX focus
now replaces a stale `NSWorkspace` frontmost cache, and recovery waits for the
actual target app before posting foreground input. Earlier helper-reported
frontmost fields alone do not establish independent focus-preservation evidence.

A real TextEdit foreground Command-A followed by typing replaced the complete
owned document. Background Command-A initially did not select that document;
the subsequent native text-selection repair is recorded below. Disabled menu
state alone is not a reliable general guard.
These tests use the separate acceptance app and are not a new packaged
Desktop/server round trip.
[Candidate keyboard evidence](https://cdn.vm0.io/artifacts/stq01jmtrp.json).

All 122 helper tests pass. The new real-process requests reject missing snapshot
ownership before any recovery policy can activate an app. Immediate request/EOF
also exposed a helper that stayed alive; queuing the stop on its main run loop
fixes the startup/EOF race, and the integration test bounds process exit.
The PR check and subsequent release acceptance record the downloadable revision.

### Native text selection and input acceptance

The downloaded `da054dc` release identifies the actual standard Select All menu
binding and sets the focused native text control's AX selection range. It checks
the target window, focus, character count, and resulting range. Unicode text
including Chinese, emoji, and combining characters selected all 51 UTF-16 units
and was replaced completely under both background policies without changing the
frontmost process. Repeated selection remained stable. A second real AppKit
application passed the same operation; its custom Command-A binding retained
key-event dispatch. Unrecognized localized bindings retain the existing path.

Safari can omit the app-level focused-element attribute while a web text control
has focus. Input now validates the focused editable field within the addressed
window. All three recovery policies inserted text at the caret chosen by an owned
page's custom JavaScript Command-A handler. Background policies preserved
frontmost without restoration; explicit foreground recovery activated Safari.
Web controls retained custom key-event semantics. With an older TextEdit window
snapshot and a newly focused second window, `never` rejected typing before input;
recovery typed only into the original window and left the second unchanged.

The older downloaded `0961405` helper returned a 10-second typing timeout while
continuing to type. An independent AX observer measured 1497 then 1815 characters
after the error, and 3540 later. Both text dispatch loops now stop before the outer
limit and report the number dispatched. The downloaded `da054dc` background test
returned in 9.19 seconds after 1184 characters, with two later observations stable
at 1198 total characters. The foreground test returned in 9.21 seconds after
1161 characters, with two observations stable at 1175. Both accepted the next
character in 0.61 seconds. No continued input was observed after either error.

[Downloaded release keyboard acceptance](https://cdn.vm0.io/artifacts/x8nzbnmn5h.json)
records helper SHA-256
`4a91d6a66e28dae47fddb6811a78127e5b8af135adbc1455a69e8322229cf166`.
[Separate candidate red/green evidence](https://cdn.vm0.io/artifacts/4qf9kkmnu6.json)
preserves the earlier debugging results and baseline timeout reproduction.

### Current configured Desktop/server command acceptance

The `da054dc` downloaded app was copied to an isolated test bundle with staging
runtime configuration, its own home, and top-level ad-hoc re-signing. All 48
file-backed Mach-O sections and all three bundled helpers match the download.
The stable acceptance parent's own grants supplied AX and Screen Recording.
This verifies a configured current app; production identity/TCC acceptance and
the normal system-browser login flow remain separate requirements.

A real native Clerk consumer handoff completed in the owned test workspace. The
app registered one host and executed 11 authenticated owner API requests through
that same app/helper, covering all nine command kinds: list, state, open,
coordinate click, scroll, set value, AX action, type, and key. Every mutation kept
the same frontmost process without restoration. Command-A and typing replaced
the complete owned document; the post-action screenshot was downloaded from the
API and visually checked. Half-page scrolling moved from 0 to 0.071179344.
Native Stop Computer Use made the host offline before the app quit.

[Configured Desktop/server acceptance and cleanup](https://cdn.vm0.io/artifacts/07ua3sgcik.json)
and the [actual API screenshot](https://cdn.vm0.io/artifacts/5prdzb7hea.png) supersede
historical packaged-scroll-pending entries above for this owned fixture only.
Broader app/input/recovery scenarios and the rest of this inventory remain open.

### External application lifecycle discovery

The `da054dc` helper could list an app it opened itself, but repeatedly missed an
existing app launched externally after exit and a newly installed app launched
externally. A fresh system lookup saw the process while the persistent helper
reported `running: false` and `app_not_found`. Restarting the helper made it visible.

App listing and bundle-ID target resolution now read `NSWorkspace` on the helper's
pumped main run loop. The command queue does not run a run loop. The existing
case-insensitive bundle-ID and multiple-instance selection policy is unchanged.
A real-process integration test builds an owned AppKit fixture and externally
launches, exits, and relaunches it while the same JSONL helper stays alive. The test
failed on the old code; all 123 helper tests pass with this change.

Two real AppKit fixtures also passed live discovery, list removal on exit, and
relaunch with new process IDs. Old window snapshots were rejected after relaunch;
new snapshots selected and replaced the intended text in the background without
changing the frontmost process. [Candidate lifecycle evidence](https://cdn.vm0.io/artifacts/nuawqxywkh.json) records
this debug helper separately from downloaded release and full-app acceptance.

The downloaded `db44cc9` release repeated both lifecycle cycles and input checks.
Its configured Desktop copy also completed 24 authenticated owner API requests
through the same app/helper processes: 20 succeeded, two correctly rejected exited
apps, and two rejected snapshots from previous processes. Eight input mutations
preserved the same actual frontmost process without restoration; four exact text
results and the API screenshot were verified. Native Stop made the host offline
before confirmed Quit. [Release and configured Desktop/server evidence](https://cdn.vm0.io/artifacts/5v8xbk61o4.json)
closes this discovery requirement for the two tested apps. The configured test
identity and grants remain distinct from production identity acceptance.

### Background editing and keyboard window ownership

The downloaded `db44cc9` helper passed eleven ordinary navigation/editing keys
under all three recovery policies on an owned AppKit text view. Both background
policies preserved frontmost without restoration. However, an older snapshot of
window A followed by focusing window B exposed a different defect: Left and
Shift-Left changed B's caret/selection, and Backspace deleted B's text. The event's
window fields did not constrain AppKit's keyboard delivery. All three requests
reported success. Standard Command-A already rejected this mismatch.

Generic key-event dispatch now compares the resolved snapshot window with the
application's current AX keyboard window immediately before posting any key.
`never` rejects mismatches before input; the existing recovery policies activate
the addressed window and verify focus before dispatch. Independently addressed
native AX shortcuts retain their existing target validation.

The unchanged real regression fails on the downloaded baseline and passes on the
candidate: nine window/policy cases leave B unchanged, reject under `never`, and
correctly edit A after explicit recovery. Eighteen additional background commands
preserve selection direction and UTF-16 boundaries across emoji skin-tone/ZWJ
sequences, combining accents, and Chinese. Real TextEdit also rejects a mismatched
Backspace and deletes only A after recovery. Safari passes navigation/selection,
one custom JavaScript Command-A handler, exact replacement at its chosen range,
and owned-tab cleanup without changing frontmost. All 123 helper tests pass.
[Baseline and candidate evidence](https://cdn.vm0.io/artifacts/alzntsqnfr.json)
records debug helper SHA-256
`269e48dfd4128c09717f148b53cc9307e42c1ada9f2330ff8e2f8897b43369cc`;
the PR check/progress record identifies the subsequent downloaded release.

**Background undo/redo remains a reproduced parity defect.** The downloaded
baseline's Command-Z and Shift-Command-Z report success without changing the
owned AppKit text; explicit foreground controls correctly undo and redo the same
edit. The text receiver records `noop:` for the background command. TextEdit
reproduces background Undo with a passing foreground control. A disabled native
Undo menu also returns success for AXPress without undoing, so direct menu dispatch
is not an accepted repair. This window-ownership fix does not close that gap or
establish a new full Desktop/server command round trip.

## Feature inventory and evidence

| Existing behavior                                                                                | Native implementation                                                               | Acceptance still required                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Okou/Zero, production/development identities, macOS 14+, arm64                                   | `DesktopConfiguration`, packaging script                                            | Both product bundles, URL scheme registration, icon and permission identity               |
| System-browser login, handoff code, workspace selection, token renewal, sign-out, restore        | `DesktopAuth`, `DesktopAPI`                                                         | Live Clerk handoff and renewal after long captures; concurrent live account changes       |
| Host start/stop, registration, heartbeat, adaptive polling, retry, revoked credentials, draining | `HostRuntime`                                                                       | Competing hosts and prolonged network recovery                                            |
| Nine Computer Use capabilities and post-action screenshot/state                                  | `ComputerCommands`, repaired native helper                                          | Background undo/redo, broader app/recovery cases, targets without AX axis bars            |
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
   complete upload/review handoff on both product identities. The current configured
   app passed all nine command kinds on its owned fixture, and the `db44cc9`
   configured app passed external launch/relaunch discovery. Background undo/redo
   and broader app/input/recovery cases still require acceptance.
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
