# Native application discovery regression proof

This macOS arm64 gate exercises the production `CuaEmbeddedRuntime`, SDK helper,
native guardian, and verified pinned CUA SDK/daemon. Its only application is a
uniquely identified temporary native `.app`. It checks the same daemon generation
before launch, after CUA cold launch, after exit, after external launch, and after
external quit/reopen with a new PID. The fixture is windowless and requires no
Accessibility, Screen Recording, Automation, or screenshot operation.

Run from `turbo/apps/desktop` after installing dependencies, building the existing
guardian proof's `owner.node` and `guardian`, and staging the real CUA payload:

```bash
proof="$PWD/.cache/cua-discovery-proof"
mkdir -p .cache
node cua/discovery-proof/build.mjs "$proof" "$native_build" "$cua_runtime"
electron="$(node -p 'require("electron")')"
"$electron" "$proof/discovery.js" "$proof"
```

All three build arguments are absolute paths. The dedicated `$proof` directory
must not exist before building. The runtime argument contains the real verified
payload from `scripts/stage-cua-runtime.py`, with native code signed for execution.
The build copies these files; it does not edit the original runtime.
Use a disposable workspace directory rather than `/tmp`: macOS marks app bundles
under `/tmp` as launch-disabled even when their LaunchServices registration succeeds.

`discovery.json` records each inventory observation, unchanged generation/daemon
identity, and production guardian cleanup evidence. Each state transition has an
eight-second observation bound; process/RPC operations retain their production
timeouts. The fixture exits through its own private stop file and has a separate
90-second self-expiry for failed experiments. Self-expiry cannot make a normal
eight-second exit assertion pass. Its LaunchServices registration is removed on
completion. No user application is launched, closed, or reconfigured. This gate
does not establish GUI interaction, Developer ID attribution, or TCC persistence.
