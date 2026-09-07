# Experimental embedded CUA runtime (slice 2)

Okou remains the only registered/default Computer Use driver. This slice ships
a dormant, host-owned runtime and a fixed verification entry point. It does not
implement a command adapter, Developer selector, preferences, renderer
diagnostics, or a runtime updater.

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
   explicitly to `@electron/osx-sign` before the outer app seal/notarization.
   Installed native code is checked by macOS code signing, the native loader,
   and exact live daemon metadata. Re-signing changes Mach-O bytes; original
   native hashes must not reject legitimate signed installations.

`LICENSE-MIT.txt`, `LICENSE-MPL-2.0.txt`, `NOTICE-MPL.txt`, `SOURCES.txt`, and
the upstream native `node-runtime-NOTICE.md` accompany the payload. The native
compatibility runtime is **MPL-2.0**, and the native package is **MIT AND
MPL-2.0**. `SOURCES.txt` identifies exact corresponding source and the upstream
build transformations. No upstream native runtime is modified.

## Runtime ownership

The CJS main bundle keeps native dynamic `import(fileURL)` for the staged ESM
entry. Loading ordinary Desktop modules does not evaluate CUA. Only the
explicit host start calls the public `EmbeddedCuaDriverHost.withOptions` and
`CuaDriver.connect`. It directly spawns the absolute packaged executable with
the build's real bundle ID, standard permission mode, a private mode-0700
endpoint directory, and both telemetry flags disabled. Overlay is disabled for
this lifecycle/probe slice. No history option or history command is enabled.

The released daemon reads persistent Computer History opt-in under `HOME`.
Only the daemon receives a fresh generation-owned home in its private directory;
the Electron process environment and macOS responsibility chain are unchanged.
This prevents inheriting an existing standalone CUA history opt-in. The directory
is removed after confirmed exit. There is no user-configurable binary, socket,
environment, permission mode, or generic command route.

SDK startup validates embedded PID/endpoint/protocol ownership. The wrapper
also requires exact `driverVersion === "0.23.2"` on both the connection and
client metadata. Starts coalesce. Stop retires admission immediately, aborts
pending client probes, retains late startup/exit results, destroys the client,
awaits native stop and the matching exit observer, destroys the host, and then
removes its private directory. A caller deadline never proves process exit:
unresolved or failed cleanup keeps that generation owned and blocks replacement.
Unexpected exit cannot replay a command, revive old readiness, or choose Okou.

## Automated package verification

From `turbo`, the macOS workflow runs both commands on the default,
production-configured, and PR preview packages:

```sh
node apps/desktop/scripts/smoke-test-packaged-app.js
node apps/desktop/scripts/smoke-test-packaged-app.js --cua-probe --signed
```

The first verifies the normal renderer bridge and reports `cua dormant`.
The second checks the real package inventory and launches the actual packaged
Electron main, loads the shipped SDK/native libraries, starts the shipped
daemon, validates metadata, passively checks permissions, stops, and observes
cleanup. It never requests TCC grants or captures an image. A missing grant is
reported as `false` and does not skip load/start/metadata/cleanup. Unsupported
platform, startup failure, and unproven cleanup fail explicitly. These checks
run on CI artifacts signed ad-hoc by the existing Forge hook (the artifact
names say "unsigned" because they lack Developer ID signing/notarization).
They verify the outer seal before accepting re-signed native bytes, and are
not installed-app TCC evidence.

The distribution fault test uses fixture archives to inject corruption, unsafe
entries, version/architecture mismatches, missing files, cache corruption, and
post-sign byte changes. Lifecycle tests mock only the external SDK/process
boundary. Neither test substitutes for the real macOS packaged probe.

## Pending signed-host and TCC acceptance (user-owned)

Use a correctly signed/notarized build or designated preview from the normal
Desktop distribution process. This issue does not authorize a release or
grant approvals. Quit any existing instance of that same build first.

1. Verify the app with `codesign --verify --deep --strict --verbose=2
"/Applications/Okou.app"` and `spctl --assess --type execute --verbose=2
"/Applications/Okou.app"`. Inspect the four nested signatures and confirm
   the app bundle ID (`ai.okou.desktop`, or `ai.okou.desktop.dev` for preview).
2. With the source checkout, set `OKOU_DESKTOP_SMOKE_APP_PATH` to that exact
   app and run the probe wrapper above with `--cua-probe --signed`. This
   verifies lifecycle/loading; shell-launched evidence alone does not prove
   LaunchServices responsibility attribution.
3. Launch the signed app itself through LaunchServices with the fixed host
   probe environment (macOS `open --env`), without a separate CUA installation:

   ```sh
   open -n --stdout /tmp/okou-cua-probe.log --stderr /tmp/okou-cua-probe-error.log \
     --env OKOU_DESKTOP_CUA_PROBE=1 --env OKOU_DESKTOP_SMOKE_TEST=1 \
     /Applications/Okou.app
   ```

   Inspect passive grant booleans, `attribution: "host"`, exact version and
   `cleanup: "confirmed"`. The host label is advisory, not proof of OS TCC
   attribution. Confirm System Settings and macOS TCC attribution logs identify
   Okou only. Never approve a separate `CuaDriver.app` entry.

4. The user grants Accessibility and Screen Recording to the signed Okou host,
   then launches a new probe process (TCC answers may be cached by old children).
   Only after those grants, repeat the LaunchServices command adding
   `--env OKOU_DESKTOP_CUA_CAPTURE=1`. This fixed route uses a named public SDK
   session and `getDesktopState`, ends that session, and saves one PNG at
   `<this build's userData>/cua-host-probe/screenshot.png` with mode 0600. Logs
   contain permission/version/cleanup metadata only. The image stays local.
   `capture: "success"` requires an actual PNG; denied grants report
   `permission_denied`, and capture errors fail the probe.
5. Revoke each grant, restart and repeat the passive probe, then regrant and
   restart. Confirm the old CUA child and its private socket directory disappear
   after each exit and no standalone CUA identity/daemon is left behind.

Signed installation, actual OS TCC responsibility, authorized screenshot content,
revocation/regrant behavior and paired real-app comparison remain **pending
user verification**. An unsigned CI pass does not complete these items or the
parent Epic. Future upgrades replace this explicit lock through normal Desktop
distribution and rerun the package/lifecycle checks.
