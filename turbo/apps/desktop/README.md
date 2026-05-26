# Zero Desktop

Electron POC for launching the hosted Zero platform app.

This pass is macOS-only. Windows packaging, native push, tray behavior, and
auto-update are intentionally out of scope. Computer Use setup lives in the
hosted Platform UI, while this app exposes the Desktop bridge and native macOS
host runtime that page uses.

When the user is signed in and the feature switch is enabled, the main process
registers a Desktop Computer Use host through the Zero API command queue. It
uses the Electron session for auth, polls queued commands, executes them with a
native macOS `computer-use-helper`, and completes commands back to the API.
Electron only owns the app shell and command bridge; the helper owns macOS
Accessibility, target-window screenshot capture, and targeted CGEvent input
dispatch.

## Development

For quick Electron development without macOS bundle behavior, use:

```bash
pnpm desktop:dev:forge
```

This launches the generic Electron app from `node_modules`, so macOS URL scheme
handlers, bundle identifiers, Dock identity, and permission prompts do not match
the packaged Desktop app.

From the monorepo root, start a packaged development app against the local proxy
with:

```bash
pnpm desktop:dev
```

This packages and runs `Zero Dev.app` with `VM0_DESKTOP_PLATFORM_URL` set to the
local proxy. Use it for sign-in callback, URL scheme, and permission testing.

The desktop build compiles both Electron entrypoints and the Swift native helper:

```bash
pnpm -F @vm0/desktop build
```

Create a macOS artifact with:

```bash
pnpm desktop:make
```

The helper source lives under `apps/desktop/native/computer-use-helper`. Build
output is copied to `apps/desktop/native/dist/native/computer-use-helper`, which
is also the path included in packaged macOS artifacts.

Point it at a local or staging platform URL with:

```bash
VM0_DESKTOP_PLATFORM_URL=https://staging-app.vm6.ai pnpm -F @vm0/desktop dev:packaged
VM0_DESKTOP_PLATFORM_URL=https://app.vm7.ai:8443 pnpm -F @vm0/desktop dev:packaged
VM0_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @vm0/desktop dev:packaged
```

The desktop app does not start platform/web/api/proxy services itself. Start the
target platform surface separately, then pass its URL through
`VM0_DESKTOP_PLATFORM_URL`.

## Internal macOS artifacts

The `Desktop` GitHub Actions workflow builds unsigned macOS artifacts for
internal testing. Run the workflow manually from GitHub Actions, then download
the `zero-desktop-macos-arm64-unsigned` artifact.

The downloaded GitHub artifact contains `Zero-darwin-arm64.zip`. Unzip both
layers, then open `Zero.app`.

These artifacts are intentionally unsigned and unnotarized. macOS Gatekeeper may
require right-clicking the app and choosing Open, or removing quarantine locally:

```bash
xattr -dr com.apple.quarantine Zero.app
```
