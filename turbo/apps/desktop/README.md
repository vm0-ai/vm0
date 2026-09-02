# Computer Use Desktop

Electron shell for the Zero and Okou products.

This pass is macOS-only. Windows packaging, native push, tray behavior, and
auto-update are intentionally out of scope. Computer Use setup lives in the
hosted Platform UI, while this app exposes the Desktop bridge and native macOS
host runtime that page uses.

Zero Computer Use and Okou support macOS 14+ (macOS 14 or newer). Packaged app
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

This packages and runs `Zero CU Dev.app` with `OKOU_DESKTOP_PLATFORM_URL` set to
the local proxy. Set `OKOU_DESKTOP_PRODUCT=okou` to package `Okou Dev.app`
instead. Use packaged development apps for sign-in callback, URL scheme, and
permission testing.
Non-CI packaged desktop builds require the `Developer ID Application: Max &
Zoe, Inc. (C5UWSXYB67)` signing identity in the local keychain. This keeps the
app's code requirement stable across rebuilds so macOS Accessibility and Screen
Recording permissions are not reset by ad-hoc signatures.

The desktop build compiles both Electron entrypoints and the Swift native helper:

```bash
pnpm -F @okouai/desktop build
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
OKOU_DESKTOP_PRODUCT=okou \
OKOU_DESKTOP_PLATFORM_URL=https://app.okou.ai \
pnpm -F @okouai/desktop make
```

That build creates `Okou.app` with bundle ID and callback scheme
`ai.okou.desktop`. Development Okou builds use
`ai.okou.desktop.dev`.
Local notarized builds use the `notarytool` Keychain profile
`vm0-desktop-notary` by default. Set `OKOU_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE` to
override the profile and `OKOU_DESKTOP_NOTARIZE_KEYCHAIN` to override the
Keychain path, or set `OKOU_DESKTOP_NOTARIZE_API_KEY_PATH`,
`OKOU_DESKTOP_NOTARIZE_API_KEY_ID`, and `OKOU_DESKTOP_NOTARIZE_API_ISSUER` to use
an API key file directly.

The helper source lives under `apps/desktop/native/computer-use-helper`. Build
output is copied to `apps/desktop/native/dist/native/computer-use-helper`, which
is also the path included in packaged macOS artifacts.

Point it at a local or staging platform URL with:

```bash
OKOU_DESKTOP_PLATFORM_URL=https://staging-app.omby.ai pnpm -F @okouai/desktop dev:packaged
OKOU_DESKTOP_PLATFORM_URL=https://app.vm7.ai:8443 pnpm -F @okouai/desktop dev:packaged
OKOU_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @okouai/desktop dev:packaged
```

The desktop app does not start platform/web/api/proxy services itself. Start the
target platform surface separately, then pass its URL through
`OKOU_DESKTOP_PLATFORM_URL`.

## Internal macOS artifacts

The `Desktop` GitHub Actions workflow builds macOS artifacts for internal
testing. Run the workflow manually from GitHub Actions, then download the Apple
silicon artifact:

- `zero-desktop-macos-arm64-unsigned` for Apple silicon Macs
- `okou-desktop-macos-arm64-unsigned` for the side-by-side Okou identity

The downloaded GitHub artifact contains `Zero-darwin-arm64.zip`. Unzip both
layers, then open `Zero Computer Use.app`.
The Okou artifact contains `Okou-darwin-arm64.zip` and
`Okou.app`.

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
`deploy-desktop` job builds the unsigned production `Zero Computer Use.app` and
`Okou.app` for Apple silicon Macs and publishes both to R2 under
`okou-desktop/<commit-sha>/`. The matching release run resolves the same commit
as `release_target`, downloads and verifies those immutable app artifacts,
signs them with the Developer ID Application certificate, notarizes them for
direct distribution outside the Mac App Store, and publishes separate releases:

- `desktop-vX.Y.Z` contains `Zero-darwin-arm64-X.Y.Z.zip` and `.dmg`.
- `okou-desktop-vX.Y.Z` contains `Okou-darwin-arm64-X.Y.Z.zip` and `.dmg`.

The release workflow then updates the independent Zero and Okou manifests.

Use the product's DMG for manual installation. It opens with a product-specific
Finder background, the app on the left, and an `/Applications` symlink on the
right for drag-to-install. Update manifests continue to point at the ZIP
artifacts because the auto-update feeds consume ZIP releases. Release smoke
tests copy Okou from the DMG into an isolated Applications directory, launch it,
replace it from the Okou update ZIP, and launch it again.

### Zero and Okou update compatibility

Zero and Okou desktop releases are independent products during the rename
rollout. Existing Zero installations keep using
`/api/desktop/updates/stable/darwin/arm64` and the `desktop-updates` manifest.
Final `ai.okou.desktop` installations use
`/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64` and the separate
`ai-okou-desktop-updates` manifest. The stable Okou download route at
`/api/desktop/updates/stable/darwin/arm64` also resolves through this
final-identity manifest. The pre-adoption Okou manifest
remains frozen without a final-identity artifact, and its explicit product
routes return `404`. Each manifest identifies its product, and the API rejects
ZIP assets whose product filename does not match the requested feed. A Zero
feed must never publish an Okou artifact, and the pre-adoption Okou feed must
never publish a final-identity archive.

The release systems may deploy independently. The API therefore preserves the
legacy Zero routes and accepts both Zero callback schemes
(`ai.vm0.zero.desktop` and `ai.vm0.zero.desktop.dev`) while also accepting the
Okou schemes (`ai.okou.desktop` and `ai.okou.desktop.dev`). Desktop
builds select exactly one product feed and one callback scheme from their
packaged identity; they do not discover or switch products at runtime.

`OKOU_DESKTOP_PRODUCT` defaults to `zero`, preserving existing local and CI
builds. Okou production builds package a runtime configuration containing
`product: okou` and `https://app.okou.ai`. That app origin routes API calls to
`api.okou.ai`, while Clerk and OAuth web flows remain canonical on
`www.vm0.ai`.

Okou is a separate macOS application identity. It can be installed beside
Zero, stores Electron data under its explicit `Okou` data directory, and gets a
new installation ID. It does not read or migrate the pre-adoption Okou profile
or Zero's Chromium profile. Users sign in again and grant Accessibility, Screen
Recording, and browser Automation permissions again because macOS TCC
associates those permissions with the application identity. The current
release promotion signs and notarizes both product lines while publishing them
under independent release tags and update manifests.

### Final Zero bridge release

The Zero migration bridge shipped, reached its `hard` stop, and has been removed
from this source tree. It no longer exists in any build produced from `main`.

Production Zero builds at version `0.34.0` or newer carry the bridge compiled
in. They poll `/api/desktop/migration-policy` every five minutes and, on `hard`,
finish the active Computer Use command, stop the Zero host, and offer only
`Download Okou` or `Quit Zero`. `hard` went live on 2026-08-31 and Zero Computer
Use traffic reached zero within about half an hour.

Because that behaviour lives in already-installed builds rather than here,
removing the source does not weaken it — but two server-side pieces must keep
working for those builds:

- **`/api/desktop/migration-policy` must keep answering `hard`.** The installed
  bridge falls back to `soft` on any request failure, so deleting or breaking
  the endpoint would silently release users the hard stop is holding.
- **The Okou DMG route must keep resolving.** `Download Okou` opens
  `https://api.vm0.ai/api/desktop/updates/stable/darwin/arm64/dmg`, the neutral
  path #28278 moved that route to. The API served the branded forms alongside it
  through `MIGRATED_BRANDED_PATHS` in `apps/api/src/signals/route-entry.ts`, on
  the reading that a build published before the move opens
  `https://api.vm0.ai/api/okou/desktop/updates/stable/darwin/arm64/dmg` instead.
  Measurement did not support it: across 2026-09-01 07:00Z to 2026-09-02 07:30Z
  every one of the 1,445 update requests, from 144 addresses, was on the neutral
  path and neither branded form took any, including from the Zero installs that
  have been polling this API since the policy went `hard`. #31088 removed those
  rows, so the neutral path above is the one that has to keep resolving.
  #26364 tracks the Zero install base itself.

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
