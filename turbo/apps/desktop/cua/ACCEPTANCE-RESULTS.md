# Paired real-Mac results — copy before use

All rows initially remain **pending-user**. Allowed status values: `pending-user`,
`pass`, `fail`, `supported-refusal`, `not-applicable` (with reason). CI/fixtures
cannot fill interactive cells. Copy each multi-case row for every case, app and
trial so one pass cannot hide a failed variant. Follow [ACCEPTANCE.md](ACCEPTANCE.md).

## Candidate and environment

| Field                                                                      | Observed value / evidence |
| -------------------------------------------------------------------------- | ------------------------- |
| Tester; UTC date; authorized test session                                  |                           |
| PR URL; final reviewed head; CI checkout; protected merge                  |                           |
| Successful run URL; artifact IDs; download URLs; expiry UTC                |                           |
| Outer Actions SHA-256; inner ZIP/DMG SHA-256 (label each)                  |                           |
| Desktop / actual Electron / CUA SDK-native-daemon versions                 |                           |
| Config/platform URL; bundle ID; display name; channel                      |                           |
| Outer/nested signing kind, authority, Team, designated requirement         |                           |
| Gatekeeper; stapling; metadata report reference                            |                           |
| Mac model/chip/RAM; macOS version/build; minimum supported macOS           |                           |
| Account/workspace (local label only); Developer availability               |                           |
| Host Accessibility / Screen Recording attribution and grant state          |                           |
| Displays/resolutions/1x/2x/scaled mode; Space; window bounds               |                           |
| Power/thermal/network; other apps/tasks; timing/resource tools             |                           |
| Existing installation ID; plugins/sessions; recording state (local labels) |                           |
| Explicit authorization for normal test input/artifact delivery             |                           |

## Applications and reset fixtures

| Family                                           | Exact bundle ID   | Installed version | Disposable document/page and starting window (local reference) |
| ------------------------------------------------ | ----------------- | ----------------- | -------------------------------------------------------------- |
| Chrome                                           | com.google.Chrome |                   |                                                                |
| Safari                                           | com.apple.Safari  |                   |                                                                |
| Electron app (name: \_\_\_)                      |                   |                   |                                                                |
| AppKit/SwiftUI app (name: \_\_\_; e.g. TextEdit) |                   |                   |                                                                |

For the native app, `com.apple.TextEdit` is an example, not a claim it is installed.
For browser action tests prepare a local disposable page with readable text,
editable control, menu/button and at least three scrollable pages. For native
apps use a disposable document with equivalent controls where supported. A
missing actionable index is a coverage limitation; never fabricate an index from
read-only markdown. Preserve the exact command payload privately for reproduction.

## Control, recovery and continuity matrix

| ID  | User steps and expected observable outcome                                                                                                                                                                                                  | Okou status  | CUA status   | Actual backend/version/generation; local evidence / deviation |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ------------------------------------------------------------- |
| C01 | Fresh eligible install, Developer Tools off: no full driver panel; opt-in false/Okou requested; passive setup/tray/state reads do not load CUA                                                                                              | pending-user | pending-user |                                                               |
| C02 | Check the one Developer Tools menu checkbox: one driver panel appears below hero/setup and all existing developer panels with Okou and CUA (Experimental); opt-in, selection, host and permissions remain unchanged                         | pending-user | pending-user |                                                               |
| C03 | Select CUA directly from default opt-in false: true/CUA saved together; Start normally if stopped; wait for actual ready generation; restart restores the choice only through current auth/Developer/TCC gates                              | pending-user | pending-user |                                                               |
| C04 | Manual Stop, change choice, restart: selection alone must not undo Stop; explicit Retry is Start                                                                                                                                            | pending-user | pending-user |                                                               |
| C05 | During a harmless admitted CUA task, uncheck/recheck Developer Tools: full panel hides/restores; saved choice and actual generation stay unchanged; task and completion finish without interruption                                         | pending-user | pending-user |                                                               |
| C06 | With Developer Tools enabled, observe permission setup and stopped/starting/failed states: lower selector/recovery remains reachable; Retry waits for cleanup; Use Okou is explicit, no replay/fallback of uncertain work                   | pending-user | pending-user |                                                               |
| C07 | Switch while a harmless command is pending; alternate selections rapidly: command and post-state retain original generation; only latest intent activates after drain                                                                       | pending-user | pending-user |                                                               |
| C08 | Stop and Quit during pending work (separate trials): no late start resurrection, no second executor; matching owned child exits and cleanup finishes                                                                                        | pending-user | pending-user |                                                               |
| C09 | Sign out/change account/workspace or observe unavailable Developer access: CUA admission withdraws; preference retained; old session cannot authorize work; normal blocked/error UI keeps compact recovery without the full driver panel    | pending-user | pending-user |                                                               |
| C10 | User revokes then regrants Accessibility and Screen Recording separately in System Settings, restarting as instructed: native admission withdraws; host-only attribution; explicit recovery, no stale ready grant                           | pending-user | pending-user |                                                               |
| C11 | Start a real filesystem/MCP plugin with an allowed disposable folder; invoke a read before/during/after switching: same host/installation/plugin session survives; native-only withdrawal does not expose legacy native capability fallback | pending-user | pending-user |                                                               |
| C12 | Start user-owned screen recording; switch drivers during it; stop/save recording explicitly: continuity and resulting playable local recording; no plugin or recorder teardown caused by switch                                             | pending-user | pending-user |                                                               |
| C13 | Naturally observed lost child/transport, unknown action completion or retained cleanup: visible failure; no automatic replay, fallback or replacement before exit proof                                                                     | pending-user | pending-user |                                                               |
| C14 | Update arrives during pending native work/cleanup/recording: updater defers per current busy policy; user resolves recording, Stop/drain, then normal install; follow signed runbook                                                        | pending-user | pending-user |                                                               |

C06/C13 injected hangs, lost-child and cleanup faults are automated in existing
SDK/process fixtures. Record that evidence separately below. Do not kill arbitrary
processes, alter binaries or manufacture a user-Mac crash to fill these rows.
If no safe manual observation is available, retain `pending-user` or explain
`not-applicable`; never replace it with a fixture “pass”.

## Application task matrix

Repeat A01–A11 for **each of the four app rows**. Copy refusals separately for
both drivers; the documented CUA limitations are not expected Okou behavior.
Use the normal authorized `okou computer-use` queue, with the exact fresh app
bundle ID/snapshot/index. Inspect subcommand help before each new shape.

| ID  | Task / supported expectation or documented CUA refusal                                                                                                                                                       | Okou status  | CUA status   | App ID/version; actual driver/version/generation; final visible state / evidence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------ | -------------------------------------------------------------------------------- |
| A01 | `list-apps`, `open-app --app`, `get-app-state --app`: exact running app/PID/window; read-only text distinct from actionable indexes; installed-only user Applications discovery limitation recorded          | pending-user | pending-user |                                                                                  |
| A02 | `type-text` with fresh snapshot into disposable focused editor: Unicode `Hello 世界 café 👋`, repeated spaces, tab and newline preserved exactly; verify visible content                                     | pending-user | pending-user |                                                                                  |
| A03 | `press-key`: supported Return/Tab/Escape/arrows and cmd/ctrl/shift/option/fn combinations, one copied trial per key/modifier combination; verify specific intended selection/navigation                      | pending-user | pending-user |                                                                                  |
| A04 | `click` on current actionable AX index with one left press; `perform-action` for supported AXPress/AXConfirm/AXShowMenu/AXPick/AXCancel/AXOpen only when exposed by that control; verify visible action/menu | pending-user | pending-user |                                                                                  |
| A05 | Coordinate click from fresh exact window image: left/right/middle and single/double variants, one trial each; correct target and foreground/cursor policy; unsupported app behavior recorded honestly        | pending-user | pending-user |                                                                                  |
| A06 | `set-value` on observed native editable control preserves Unicode; recognized browser bundles correctly refuse CUA assignment; do not relabel refusal as successful browser navigation                       | pending-user | pending-user |                                                                                  |
| A07 | Whole-window `scroll --direction down --pages 1`, then up: supported 1–25 whole vertical pages; separately observe whether content moved; background delivery alone is insufficient                          | pending-user | pending-user |                                                                                  |
| A08 | Deliberately use prior snapshot/index/raw ID after refresh or driver switch: CUA rejects stale owner; then take fresh state and act once; no old-window mutation                                             | pending-user | pending-user |                                                                                  |
| A09 | AX non-left/double click and unknown action such as AXRaise: CUA refuses before actuation; distinguish CLI/API validation refusal from adapter refusal                                                       | pending-user | pending-user |                                                                                  |
| A10 | Fractional, element-targeted and horizontal scroll (separate cases): documented CUA refusal; no substituted whole-page action or hidden fallback                                                             | pending-user | pending-user |                                                                                  |
| A11 | Unsupported key/chord, duplicate modifier, empty/oversized text and trailing protocol-tag text: explicit refusal at documented boundary; use synthetic disposable input, never production text               | pending-user | pending-user |                                                                                  |

## Window, geometry and capture matrix

Repeat with each applicable app, keeping the target's bundle/PID/window identity
and initial image dimensions locally. A correct refusal is acceptable only when
[ADAPTER.md](ADAPTER.md) documents it; wrong-window or full-screen capture is a failure.

| ID  | User steps and expected result                                                                                                                                                 | Okou status  | CUA status   | Actual driver/generation; window/scale/Space; local evidence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------ | ------------------------------------------------------------ |
| W01 | Open multiple windows without a retained owner: ambiguous initial target refused; with a retained current owner use that exact window                                          | pending-user | pending-user |                                                              |
| W02 | Close target window/app, then relaunch; stale PID/window/IDs rejected; new state obtains a fresh owner                                                                         | pending-user | pending-user |                                                              |
| W03 | Minimize, move partly/fully offscreen and place in another Space (separate trials): exact target capture or explicit unavailable/refusal; no full-screen/wrong-window fallback | pending-user | pending-user |                                                              |
| W04 | Capture at 1x, 2x and user-scaled modes; record PNG dimensions, bounds/scale; coordinate mapping once, target pixels correct                                                   | pending-user | pending-user |                                                              |
| W05 | Move/resize window or change display scale after snapshot: stale pixel action refused, then fresh state works if shape supported                                               | pending-user | pending-user |                                                              |
| W06 | Compare foreground policies `never`, `always`, `on-window-unavailable`: record actual focus/cursor disruption and delivery/effect; no uncertain recovery replay                | pending-user | pending-user |                                                              |

## Raw paired trial record

Duplicate this table per task/case/trial; leave all measurement fields empty
until observed. Pair order alternates and conditions/reset must match.

| Field                                                                              | Okou         | CUA          |
| ---------------------------------------------------------------------------------- | ------------ | ------------ |
| Task/case/app ID and version; trial number/order; UTC time                         |              |              |
| Exact candidate; actual backend/version/generation; fresh snapshot local reference |              |              |
| Reset state/window/Space/scaling/foreground policy                                 |              |              |
| Status; intended task success; visible final state                                 | pending-user | pending-user |
| Refusal/error; effect; route; delivery; unknown completion                         |              |              |
| Foreground and cursor disruption; observation error                                |              |              |
| Cold Start milliseconds (Start → ready); clock/tool                                |              |              |
| Warm task milliseconds (submission → delivered completion); clock/tool             |              |              |
| Desktop execution milliseconds; separately observed UI completion time             |              |              |
| Image encoded bytes/format/dimensions; text UTF-8 bytes                            |              |              |
| Idle/task CPU; RSS MiB; process set; sampling interval/window; peak/mean           |              |              |
| Child exit/cleanup observations; stale targets invalidated                         |              |              |
| Private evidence reference; deviations/limitations                                 |              |              |

Summary per unchanged task/condition: completed/failed/refused counts **_;
raw sample count _**; cold/warm split **_; p50 (at least 10) _**;
p95 (at least 40, nearest-rank) **_; units _**; tool/clock **_;
exclusions with reasons _**. No parity or performance improvement is inferred
from missing samples, CI speed or upstream claims.

## Evidence boundaries and final decision

| Evidence class                                                  | Exact reference | Result       |
| --------------------------------------------------------------- | --------------- | ------------ |
| Final-head targeted/PR tests and three packaged lifecycle lanes |                 | pending-user |
| User-performed four-app/window/TCC/task/continuity matrix       |                 | pending-user |
| Same-identity signed upgrade and rollback records               |                 | pending-user |
| Known failures/limitations and focused repair issue(s)          |                 | pending-user |
| User acceptance decision/date                                   |                 | pending-user |

The first row records reviewed automation only; it cannot mark any other row
passed. Keep the Epic open and manual acceptance unchecked until the user decides.
