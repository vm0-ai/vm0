# Host-owned CUA command adapter (0.23.2)

`createCuaComputerUseDriver` is an internal composition seam for
`ComputerUseDriverController` and the existing executor/host. `main.ts` keeps
Okou as the default and selects this adapter only through the local Developer
experiment described in [README.md](README.md). The factory itself is not a
renderer IPC or an agent-controlled tool interface. Public commands, auth, queue,
errors, result/artifact envelopes and the packaged distribution remain unchanged.

The sole source contract is CUA **0.23.2**, commit
[`e88e9d899ac5effaeae38619527ebaa46b26ce72`](https://github.com/trycua/cua/tree/e88e9d899ac5effaeae38619527ebaa46b26ce72/libs/cua-driver).
The public SDK's typed desktop methods omit macOS PID/window/token inputs. The
adapter uses public `callTool` with a closed tool-name union and individually
constructed fields. It never forwards command payload JSON, private bindings,
worker messages, profiles, shell commands or arbitrary tool names.

## Supported and refused shapes

| Public command           | Fixed public tools and supported shape                                                                                                 | Explicit refusal/limitation                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps.list`              | `list_apps`; names, optional bundle/path, installed/running and PID retained                                                           | Installed `pid: 0` cannot be targeted; discovery is bounded below                                                                                      |
| `app.open`               | `launch_app(bundle_id)`; validate launch identity/state and obtain post-state                                                          | Exact bundle ID required; no arguments, URL navigation or profiles                                                                                     |
| `app.state`              | `list_apps`, `list_windows`, `get_window_state`; exact live PID and retained/sole window                                               | Ambiguous/missing owners, invalid screenshot frame or geometry                                                                                         |
| `element.click`          | `click`; current opaque AX token for one left press, or retained window pixels for left/right/middle single/double click               | Stale ID/index, AX double/non-left clicks, moved/resized/scale-changed windows, out-of-image points                                                    |
| `element.set_value`      | `set_value` on an observed native-app element; exact Unicode value and upstream evidence                                               | Browser bundle IDs are conservatively refused: released rows cannot identify address fields reliably, and AX assignment is not Apple Events navigation |
| `element.perform_action` | `click` with closed `AXPress`, `AXConfirm`, `AXShowMenu`, `AXPick`, `AXCancel`, `AXOpen` translations (and equivalent lowercase names) | Unknown names, including `AXRaise`, never reach upstream's default-to-press behavior                                                                   |
| `keyboard.type_text`     | `type_text` into the exact observed window; Unicode and whitespace preserved                                                           | Empty/oversized text and trailing protocol tags that 0.23.2 strips                                                                                     |
| `keyboard.press_key`     | `press_key`; explicit key aliases and cmd/ctrl/shift/option/fn modifiers                                                               | Unknown keys, repeated modifiers, unsupported punctuation/chords                                                                                       |
| `element.scroll`         | `scroll`, `by: page`, 1–25 whole up/down pages of the focused window                                                                   | Targeted/fractional/horizontal scrolling; background page delivery does not prove content movement                                                     |

`never` and `on-window-unavailable` request background delivery; `always`
requests foreground delivery where the command supports that policy. The
conditional policy permits recovery but does not require an unsafe retry. No
upstream suggestion triggers escalation, another route, another driver or replay.

## Addressing, observations and facts

One generation owns one embedded process/client/session and one current
observation. Host-generated session labels are not authorization. Every host
snapshot and opaque element ID binds bundle/PID/path/window, CUA snapshot and
token; the generation-local store adds generation ownership. A refresh clears
the old mapping before awaiting anything, including failed refreshes. Numeric
indexes require the exact current snapshot. Raw IDs undergo the same retained
ownership checks. Old LRU entries, same-millisecond observations, switching back,
or late callbacks cannot recreate authorization.

`tree_markdown` preserves visible/read-only text. Structured rows contain only
upstream actionable indexes and opaque tokens; no reindexing or fake clickable
tree is created. Coverage is explicitly incomplete, and degraded reasons are
retained. One window PNG must agree with its bounded header dimensions, frame,
window bounds and 1x/2x scale. Upstream downsizing is retained through the shared
executor. Pixel dispatch refreshes the public frame and rejects changed owners
or geometry; it passes image-local coordinates through CUA's resize mapping
once. Derived screen coordinates are labeled `retained_request_frame` request
metadata, never fabricated CUA evidence. There is no full-screen fallback.

The public result retains CUA `effect`, `route`, `delivery` and `evidence`.
`partial`, `unverifiable` and `suspected_noop` remain visible even when transport
succeeds. `confirmed` requires evidence. `refused` maps to the supported public
failure envelope with serialized facts in its message. A failed post-state keeps
completed action facts plus `observationError`. Transport failure or deadline
reports potentially unknown completion, never safe-to-retry success. No legacy
unconditional success summary overrides these facts.

## Deadline and retirement

The host preserves wire `timeoutMs`, `createdAt` and nullable `claimedAt` before
its permission query. Explicit timeout is 1–120 seconds; CLI normally sends
30 seconds and API creation defaults to 60 seconds. Only stored `null` uses the
existing 120-second policy. Missing, malformed or future dates fail closed;
`claimedAt` cannot restart the budget. Queue/transit age is subtracted once using
wall time, then one monotonic deadline covers permission, session, discovery,
action and post-state. Completion reserves at most one second (10% for a short
remaining budget) and its requests/retries consume the same deadline. No network
submission can be guaranteed after the server's command deadline has elapsed.

Already-expired claims report no native action started. An in-flight timeout
reports potentially delivered/unknown work. A network response arriving after
poll cancellation remains leased through its failure submission, using the
original remaining budget; its action is never dispatched. Fresh CUA permissions also have a
bounded five-second readiness check within that command budget. Permission
revocation, unexpected exit, fatal transport failure, timeout and lifecycle Stop
withdraw native admission and invalidate targets. Public embedded `stop()` starts
before awaiting hung SDK work or `endSession`; the pinned implementation has its
own shutdown/kill/reap channel. AbortSignal and JavaScript races are not proof.
Replacement remains blocked until all owned callbacks settle, the matching child
exit/stopped state is observed, and client/host cleanup completes. Unproven cleanup
stays owned even after its caller-facing deadline; it never permits a fresh Okou
or CUA executor. No uncertain action is replayed.

## Capabilities and privacy

Native capability publication and pre-claim leases derive from actual backend
readiness and fresh permissions. Authenticated plugin preparation can establish
real non-empty plugin capabilities before host registration when native TCC is
unavailable. Plugin-only claims do not obtain a native lease or query native TCC.
Existing auth, heartbeat, plugin and recorder owners remain authoritative during
switching. With no real capabilities, the host stops: publishing `[]` would
reactivate the server's intentional legacy native fallback. Server semantics are
unchanged and covered through public create/claim routes.

The daemon retains its private child home, preventing standalone Computer
History opt-in from being inherited. Running apps and system application
directories can be enumerated, but installed-only apps in the real user's
`~/Applications` are outside that scan. `apps.list` reports this limitation. The
adapter does not relax privacy isolation to claim complete app discovery.

## Evidence and user-owned pending checks

`computer-use-cua.test.ts` and `computer-use-cua-host.test.ts` compose the actual
adapter, runtime, driver, shared executor and host; only the external public
SDK/native and network boundaries are substituted. Plugin tests run the real
filesystem MCP process. They cover command mapping/refusal, stale targets,
geometry, facts, late/hung work, budgets and plugin-only operation. Existing
driver/host/controller tests retain Stop/auth/Quit/update/claim/recorder ownership
coverage. API BDD tests use real routes/database for plugin-only and legacy
capability compatibility. CLI deadline tests retain the 30-second policy.

The existing macOS package CI continues to run the actual pinned SDK/native/
daemon probe and ordinary dormant smoke in default, production-configured and
PR-preview lanes. Those ad-hoc signed package checks prove distribution/loading/
lifecycle only. They do not prove the fixture action behavior on an interactive
Mac. Developer ID/notarized installation, actual host TCC attribution, revoked/
regranted access, real application/window/Unicode/scroll behavior, screenshot
content, paired Okou comparison and performance remain **unproven and pending
user acceptance in slice 5**. The Developer selector does not establish interactive acceptance or authorize a release.
