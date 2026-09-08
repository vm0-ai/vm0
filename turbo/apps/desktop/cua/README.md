# Experimental embedded CUA runtime and adapter

Okou is the default Computer Use driver. The pinned official macOS arm64
embedded runtime and [command adapter](ADAPTER.md) are available only through an
explicit local CUA selection by a current Developer. Ordinary startup does not
load CUA. This adds no agent-facing driver parameter, runtime download or release.

## Distribution and integrity

`artifacts.json` is the build lock for the runtime closure. All three CUA
components are exactly **0.23.2**, source commit
`e88e9d899ac5effaeae38619527ebaa46b26ce72`. GitHub labels the component release
prerelease; this integration remains experimental. The SDK is a development
dependency for public types only. The workspace lock pins its dependencies, but
the shipped closure is assembled independently from the manifest's verified
tarballs, without `npm install`, lifecycle scripts, platform auto-selection, or
workspace symlinks.

| Original archive         | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| bare universal daemon    | `0127c82ff17922df4290931a8ebf9b4a8b21656aad24cba6f21ee50e41ed4493` |
| SDK                      | `adb6e4a80b0a8259c7a03a0918db4e228f3ca48f4a98d13b43a2dfde76de8c82` |
| arm64 native SDK package | `953991a6805c4b11003cdc75c6e615f4a48c02e68893959af6cbd2e09e299469` |
| `@ubjs/core` 0.31.0-3    | `74d7950698bdc74569a8e754b2d5dc055a43afdd0647c0171595f9b77e8c7151` |
| `@ubjs/node` 0.31.0-3    | `e5c18f3cfc46d072f9aa23439644c9c18fac62729e6385aadcc937e458507a09` |

The actual downloaded bytes were checked against these hashes. The SDK and
native package also match their npm lockfile SHA-512 integrity. The daemon
archive includes two universal executables plus duplicate universal SDK
libraries and a C header. Ship the executables (`cua-driver`,
`cua-cursor-theme`) and use the pinned arm64 npm native libraries; omit the
duplicate libraries/header. The SDK root/native JS, `@ubjs/core` ESM JS, and
`@ubjs/node` library resolver retain their original package-relative layout.
Other platform packages, source trees, standalone `CuaDriver.app`, and the
unused `@ubjs/node` native runtime are not shipped.

`pnpm build:cua` uses Python 3's standard library and system curl to verify
archives before extraction, restrict downloads and redirects to official HTTPS hosts, reject
unsafe entries/links, check package versions and arm64
Mach-O headers, and stage `native/dist/cua`. This directory survives tsup's
`dist` cleanup and Forge copies it to `Contents/Resources/cua`, while still
excluding root `node_modules`. Cache entries are original archives keyed by
hash and are reverified on every use. No application launch downloads code.

Three integrity domains are intentionally distinct:

1. `artifacts.json` verifies original upstream bytes before extraction.
2. `payload.json` records every staged unsigned file. The packaged probe checks
   the complete inventory and hashes before loading the SDK. Signed verification
   excludes native bytes from that comparison, retaining JS/notice checks.
3. Both Forge signing and artifact promotion pass the four CUA Mach-O paths
   and the first-party `cua-owner.node` / `cua-guardian` paths explicitly to
   `@electron/osx-sign` before the outer app seal/notarization.
   Installed native code is checked by macOS code signing, the native loader,
   and exact live daemon metadata. Re-signing changes Mach-O bytes; original
   native hashes must not reject legitimate signed installations.

`LICENSE-MIT.txt`, `LICENSE-MPL-2.0.txt`, `NOTICE-MPL.txt`, `SOURCES.txt`, and
the upstream native `node-runtime-NOTICE.md` accompany the payload. The native
compatibility runtime is **MPL-2.0**, and the native package is **MIT AND
MPL-2.0**. `SOURCES.txt` identifies exact corresponding source and the upstream
build transformations. No upstream native runtime is modified.

## Runtime ownership

The complete public SDK, host, client, session, cancellation and destruction
run in one app-owned SDK process per generation. Only its fixed
`Resources/native/cua-sdk-process.js` entry imports the staged ESM SDK and calls
`EmbeddedCuaDriverHost.withOptions` / `CuaDriver.connect`. Main retains admission,
permissions UI, snapshots, deadlines and first-party lifecycle supervision;
ordinary startup and passive permission reads neither load CUA nor launch it.
The helper uses the bundled Electron executable, never system Node. It starts
the absolute packaged daemon with the build's real bundle ID, standard permission
mode, a private mode-0700 directory and both telemetry flags disabled. Overlay
and history remain disabled.

The [guardian topology and macOS proof](guardian-proof/README.md) describe the
native spawn gate, retained waitable identity, independent process-group
observation and reaping. The first-party guardian is outside the SDK kill group
and cannot load CUA. Main can resume an exactly retained, explicitly stopped
guardian so it can reap its child; no signal return counts as exit evidence.
The private typed channel accepts only the adapter/probe's fixed methods, with
generation/request IDs, bounded messages/in-flight work and execution deadlines.
No arbitrary executable, tool, environment or sensitive token is forwarded.

The released daemon reads persistent Computer History opt-in under `HOME`.
Only the daemon receives a fresh generation-owned home in its private directory;
the Electron process environment and macOS responsibility chain are unchanged.
This prevents inheriting an existing standalone CUA history opt-in. The directory
is removed after confirmed exit. There is no user-configurable binary, socket,
environment, permission mode, or generic command route.

SDK startup validates embedded PID/endpoint/protocol ownership and exact
`driverVersion === "0.23.2"` on connection and metadata. Stop publishes its
single-flight retirement and one five-second budget before requesting any
native cancellation. Healthy cleanup ends sessions, stops and observes the
daemon, destroys native objects and exits the helper. Three seconds are reserved
for that work; the remaining two cover repeated scoped force and independent
exit observation. Both branches require guardian exit and an empty owned group
before reaping the retained identity and removing the private directory.
Quit/update/Stop/auth withdrawal/switch/expiry/start failure/probe share this
owner. A failed observation retains `cleanup_unproven`, blocks replacement/update
and leaves main responsive. Cancel preserves the existing session. Late results
cannot revive readiness or replay a command, and no driver fallback is automatic.

## Automated package verification

See the consolidated [acceptance guide](ACCEPTANCE.md),
[fillable paired results](ACCEPTANCE-RESULTS.md) and
[signed upgrade/rollback runbook](UPGRADE-ROLLBACK.md).

**Dedicated CI/test OS account only:** ordinary smoke signs out and bootstrap
uses the real product userData. It initializes normal services, including the
production updater. It is not a read-only installed-profile check; moving an
app or passing an arbitrary Electron profile flag does not isolate that state.
Use `inspect-cua-package.py` from the guide for inspection without launching.

From `turbo`, the macOS workflow runs these commands on the default,
production-configured, and PR preview packages:

```sh
node apps/desktop/scripts/smoke-test-packaged-app.js
node apps/desktop/scripts/smoke-test-packaged-app.js --cua-probe --signed
node apps/desktop/scripts/smoke-test-packaged-app.js --cua-forced-probe --signed
```

The first verifies the real preload/auth/driver-control bridge and initial plus
settled off/Okou driver state. It rechecks actual SDK dormancy after both IPC
reads and passive permission refresh.
The second checks the real package inventory and launches the actual packaged
Electron main and isolated helper, loads the shipped SDK/native libraries, starts the shipped
daemon, validates metadata, passively checks permissions, stops, and observes
matching-generation exit, stopped host and removed private directory. Structured
evidence must contain exact metadata/version/state fields and successful child
and Electron termination. A text cleanup marker, forced exit or timer expiry
cannot pass. It never requests TCC grants or captures an image. A missing grant is
reported as `false` and does not skip load/start/metadata/cleanup. Unsupported
platform, startup failure, and unproven cleanup fail explicitly. These checks
run on CI artifacts signed ad-hoc by the existing Forge hook (the artifact
names say "unsigned" because they lack Developer ID signing/notarization).
They verify the outer seal before accepting re-signed native bytes, and are
not installed-app TCC evidence.

The third deliberately blocks helper execution before native cleanup and
requires independently confirmed process retirement within the same five-second
budget while main heartbeats continue. Its `forced.json` keeps native graceful
success false and labels forced recovery separately. The 27-case guardian proof
also covers startup-before-ready, owner death/pause, repeated launch/stop and
failed-force/identity/observation fences. A separate real-Electron nine-command
round trip uses the production guardian/helper/IPC and substitutes only public
SDK responses; it operates no actual apps. Native metadata/cancel stress uses
the real pinned SDK, but neither fixture establishes the original mutex race.

The distribution fault test uses fixture archives to inject corruption, unsafe
entries, version/architecture mismatches, missing files, cache corruption, and
post-sign byte changes. Lifecycle tests mock only the external SDK/process
boundary. Neither test substitutes for the real macOS packaged probe.

## Pending signed-host and TCC acceptance (user-owned)

Use [ACCEPTANCE.md](ACCEPTANCE.md) for exact-source downloads, observed signing,
read-only inspection and the explicit boundary between dedicated test launches
and user-owned interaction. [ACCEPTANCE-RESULTS.md](ACCEPTANCE-RESULTS.md) covers
real TCC grants/revocation, four application families, screenshots/Spaces/scaling,
supported/refused actions, plugin/recording continuity and paired measurements.
No interactive field is filled by CI. A reported `host` label is not evidence
of macOS responsibility attribution or actual task success.

The existing fixed host probe also supports explicitly user-requested local
capture with `OKOU_DESKTOP_CUA_CAPTURE=1`, after normal host TCC authorization.
It writes `<this build's userData>/cua-host-probe/screenshot.png` (mode 0600),
overwriting any previous probe PNG. This is a separate SDK lifecycle/capture
operation, not a selected-driver command-queue task. It launches the app and
can initialize bootstrap's updater; it is not read-only profile inspection.
The no-capture CI wrapper always sets this flag to `0`. No image or input is
included in package evidence or uploaded by the fixed probe. The user owns any
interactive launch, grant, local capture and decision to share sanitized output.

Developer ID/notarized installation, actual host attribution, real application
behavior and [same-identity signed upgrade/rollback](UPGRADE-ROLLBACK.md) remain
pending-user until performed on a matching normally distributed signed build.
An ad-hoc preview is not proof of production TCC persistence and does not
authorize signing promotion, release or Epic acceptance.

## Developer selection and recovery

Check **Developer Tools** in the app menu to reveal **Computer Use driver** at
the bottom of the main page, after the hero/setup and existing developer panels.
The fresh/default installation offers **Okou** and **CUA (Experimental)** directly.
Selecting CUA is the experimental opt-in; showing the panel alone does not save
an opt-in, switch drivers, start a stopped host or request OS permissions.
Unchecking Developer Tools hides the full panel without changing the preference,
current generation or admitted command. CUA is experimental; the
[0.23.2 adapter contract](ADAPTER.md) is unchanged. There is no implicit
browser/Okou fallback or action replay.

The local `computerUseDriver` preference contains only `experimentalCuaEnabled`
and `selectedDriver` (`okou` or `cua`). Missing/invalid fields use off/Okou.
An authorized explicit CUA choice saves true/CUA in one atomic transaction before
requesting a runtime transition. A failed save retains the prior choice and
cannot authorize CUA. Existing valid saved choices remain readable, without a
format migration. Writes preserve installation, keep-awake and plugin data.
Corrupt/unreadable settings are reported without overwriting them.
Authorization, native processes and readiness are never persisted.

CUA requires a currently authenticated user/workspace/session, newly resolved
`_debug` authority, opt-in and a running/explicit Start intent. An unresolved or
revoked Developer result blocks CUA and retains the choice. Old responses cannot
authorize a new session. Setup/tray/state reads use Electron host permission
status without loading either actuator. Explicit Accessibility requests prompt
the signed host; Screen Recording requests open its macOS Privacy settings.
Ready CUA command/heartbeat checks still withdraw admission on revocation.

With Developer Tools enabled, the lower panel remains available during setup,
Stop, starting, switching and errors. When tools are hidden or Developer access
is unavailable, blocked/error states retain only compact explicit recovery in
the normal page, without a selector or full diagnostics.
Selecting while stopped persists the choice without starting it. A running
switch drains the entire claim/action/post-state/completion, retires the old
generation, and resumes the same cloud host and plugin processes. Rapid choices
retain only the latest activation intent, including a repeated CUA choice after
an intervening Okou choice. Stop, auth changes and update/quit supersede startup.
Click **Use Okou** or select **Okou** to request a driver change. Collapsing
Developer Tools never requests a change; reopening it restores current diagnostics.

**Retry** is an explicit Start. **Use Okou** changes the request only; neither
bypasses retained cleanup or a manual Stop. A native failure can retain the real
non-empty plugin-only host; otherwise the host stops. No unknown action result
is retried automatically. Updates remain deferred during start, replacement,
retirement and retained cleanup after a caller-facing timeout.

Diagnostics distinguish requested driver, actual controller generation and
ready build/runtime version. The packaged CUA version is labeled **expected**;
a stopped/unready runtime has no loaded-version claim. Lifecycle elapsed time
is bounded to 120 seconds from the most recent lifecycle intent. Native command
logs retain only driver ID, version and controller generation captured before
claim, even if preference changes before completion. Embedded SDK generation is
a different scope. New errors are bounded categories without SDK messages,
paths, endpoints, session labels or screen/input content.

### Interactive acceptance still pending

Use a Developer ID signed installation with the intended host identity. Verify
menu/keyboard selection and recovery with permissions missing, startup delayed,
CUA failed, manually stopped and Developer access withdrawn. Confirm native
TCC attribution/grant/revocation, real target screenshots and paired app actions
against [ADAPTER.md](ADAPTER.md), plus recording continuity and update/rollback.
The deterministic renderer/OS-boundary tests do not prove these interactions.
The three actual macOS CI package smoke/probe lanes remain ad-hoc signed and do
not constitute Developer ID, real TCC, performance or final user acceptance.
