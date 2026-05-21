# Zero Desktop

Electron POC for launching the hosted Zero platform app.

This pass is macOS-only. Windows packaging, native push, tray behavior, and
auto-update are intentionally out of scope. Computer Use setup lives in the
hosted Platform UI, while this app exposes the Desktop bridge and native macOS
host runtime that page uses.

When the user is signed in and the feature switch is enabled, the main process
registers a Desktop Computer Use host through the Zero API command queue. It
uses the Electron session for auth, polls queued commands, executes them with
macOS Accessibility/JXA, and completes commands back to the API.

## Development

By default the app opens production:

```bash
pnpm -F @vm0/desktop dev
```

Point it at a local or staging platform URL with:

```bash
VM0_DESKTOP_PLATFORM_URL=https://staging-app.vm6.ai pnpm -F @vm0/desktop dev
VM0_DESKTOP_PLATFORM_URL=https://app.vm7.ai pnpm -F @vm0/desktop dev
VM0_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @vm0/desktop dev
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
