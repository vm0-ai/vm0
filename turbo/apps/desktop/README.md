# Computer Use Desktop

Electron shell for the Zero and Okou Computer Use products.

This pass is macOS-only. Windows packaging, native push, tray behavior, and
auto-update are intentionally out of scope. Computer Use setup lives in the
hosted Platform UI, while this app exposes the Desktop bridge and native macOS
host runtime that page uses.

Zero Computer Use and Okou Computer Use support macOS 14+ (macOS 14 or newer). Packaged app
metadata, native helper builds, and release verification all use the same
minimum for Apple silicon artifacts. Intel Macs are not supported.

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

This packages and runs `Zero CU Dev.app` with `VM0_DESKTOP_PLATFORM_URL` set to
the local proxy. Set `VM0_DESKTOP_PRODUCT=okou` to package `Okou CU Dev.app`
instead. Use packaged development apps for sign-in callback, URL scheme, and
permission testing.
Non-CI packaged desktop builds require the `Developer ID Application: Max &
Zoe, Inc. (C5UWSXYB67)` signing identity in the local keychain. This keeps the
app's code requirement stable across rebuilds so macOS Accessibility and Screen
Recording permissions are not reset by ad-hoc signatures.

The desktop build compiles both Electron entrypoints and the Swift native helper:

```bash
pnpm -F @vm0/desktop build
```

Create a macOS artifact with:

```bash
pnpm desktop:make
```

This builds the production `Zero Computer Use.app`, signs it with the local
Developer ID Application identity, submits it to Apple's notary service, staples the
notarization ticket, and writes the zip artifact under `apps/desktop/out/make`.
Build the independent Okou identity with:

```bash
VM0_DESKTOP_PRODUCT=okou \
VM0_DESKTOP_PLATFORM_URL=https://app.okou.ai \
pnpm -F @vm0/desktop make
```

That build creates `Okou Computer Use.app` with bundle ID and callback scheme
`ai.okou.computer-use`. Development Okou builds use
`ai.okou.computer-use.dev`.
Local notarized builds use the `notarytool` Keychain profile
`vm0-desktop-notary` by default. Set `VM0_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE` to
override the profile and `VM0_DESKTOP_NOTARIZE_KEYCHAIN` to override the
Keychain path, or set `VM0_DESKTOP_NOTARIZE_API_KEY_PATH`,
`VM0_DESKTOP_NOTARIZE_API_KEY_ID`, and `VM0_DESKTOP_NOTARIZE_API_ISSUER` to use
an API key file directly.

The helper source lives under `apps/desktop/native/computer-use-helper`. Build
output is copied to `apps/desktop/native/dist/native/computer-use-helper`, which
is also the path included in packaged macOS artifacts.

Point it at a local or staging platform URL with:

```bash
VM0_DESKTOP_PLATFORM_URL=https://staging-app.omby.ai pnpm -F @vm0/desktop dev:packaged
VM0_DESKTOP_PLATFORM_URL=https://app.vm7.ai:8443 pnpm -F @vm0/desktop dev:packaged
VM0_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @vm0/desktop dev:packaged
```

The desktop app does not start platform/web/api/proxy services itself. Start the
target platform surface separately, then pass its URL through
`VM0_DESKTOP_PLATFORM_URL`.

## Internal macOS artifacts

The `Desktop` GitHub Actions workflow builds macOS artifacts for internal
testing. Run the workflow manually from GitHub Actions, then download the Apple
silicon artifact:

- `zero-desktop-macos-arm64-unsigned` for Apple silicon Macs
- `okou-desktop-macos-arm64-unsigned` for the side-by-side Okou identity

The downloaded GitHub artifact contains `Zero-darwin-arm64.zip`. Unzip both
layers, then open `Zero Computer Use.app`.
The Okou artifact contains `Okou-darwin-arm64.zip` and
`Okou Computer Use.app`.

These artifacts are ad-hoc signed, not Developer ID signed, and not notarized.
macOS Gatekeeper may require right-clicking the app and choosing Open, or
removing quarantine locally:

```bash
xattr -dr com.apple.quarantine "Zero Computer Use.app"
```

## Release artifacts

Desktop releases are versioned by release-please. Changes under
`turbo/apps/desktop` with release-worthy Conventional Commit types update
`package.json`, this changelog, and the manifest entry, then create a
`desktop-vX.Y.Z` GitHub Release.

When a release-please merge group changes the Desktop package version, the
`deploy-desktop` job builds the unsigned production `Zero Computer Use.app` for
Apple silicon Macs and publishes it to R2 under
`okou-desktop/<commit-sha>/`. The matching release run resolves the same commit
as `release_target`, downloads and verifies that immutable app artifact, signs
it with the Developer ID Application certificate, notarizes it for direct
distribution outside the Mac App Store, and uploads
`Zero-darwin-arm64-X.Y.Z.zip` and `Zero-darwin-arm64-X.Y.Z.dmg` to the matching
GitHub Release. The release workflow then updates the Desktop update manifest.

Use the DMG for manual installation. It opens with a styled Finder background,
`Zero Computer Use.app` on the left, and an `/Applications` symlink on the right
for drag-to-install. The update manifest continues to point at the ZIP artifact
because the auto-update feed consumes ZIP releases.

### Zero and Okou update compatibility

Zero and Okou desktop releases are independent products during the rename
rollout. Existing Zero installations keep using
`/api/desktop/updates/stable/darwin/arm64` and the `desktop-updates` manifest.
Okou installations use
`/api/desktop/updates/okou/stable/darwin/arm64` and the separate
`okou-desktop-updates` manifest. Each manifest identifies its product, and the
API rejects ZIP assets whose product filename does not match the requested
feed. A Zero feed must never publish an Okou artifact, or vice versa.

The release systems may deploy independently. The API therefore preserves the
legacy Zero routes and accepts both Zero callback schemes
(`ai.vm0.zero.desktop` and `ai.vm0.zero.desktop.dev`) while also accepting the
Okou schemes (`ai.okou.computer-use` and `ai.okou.computer-use.dev`). Desktop
builds select exactly one product feed and one callback scheme from their
packaged identity; they do not discover or switch products at runtime.

`VM0_DESKTOP_PRODUCT` defaults to `zero`, preserving existing local and CI
builds. Okou production builds package a runtime configuration containing
`product: okou` and `https://app.okou.ai`; that app origin intentionally maps to
the current `api.vm0.ai` and `www.vm0.ai` services until the separate
`api.okou.ai` readiness gate passes.

Okou is a separate macOS application identity. It can be installed beside
Zero, gets its own Electron `userData` root and installation ID, and does not
copy Zero's Chromium profile. Users sign in again and grant Accessibility,
Screen Recording, and browser Automation permissions again because macOS TCC
associates those permissions with the application identity. The current
release promotion remains on the Zero line until the signed Okou promotion
workflow is enabled.

This does not submit or publish the app to the Mac App Store. The App Store
Connect API key is only used as notarytool authentication for Apple's
notarization service.

The release job requires these GitHub secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_KEYCHAIN_PASSWORD`
- `APP_STORE_CONNECT_API_KEY_BASE64`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_API_ISSUER_ID`
