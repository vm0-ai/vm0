# Swift-native macOS Desktop

The macOS Desktop rewrite uses SwiftUI/AppKit for the interface, Foundation for
the host command queue, and the existing Swift Computer Use and ScreenCaptureKit
helpers. It does not bundle Electron, Chromium, Node.js, React, or a local web
server. WebKit is limited to the existing hosted Clerk authentication handoff
and workspace picker.

This implementation is under feature-parity verification. The existing Electron
release remains the comparison baseline while the native PR is reviewed. See
[PARITY.md](PARITY.md) for the scope and remaining acceptance work.

## Download from a pull request

Open the **Desktop Swift / swift-macos-arm64** check. After it passes, the job
summary links the **okou-swift-desktop-macos-arm64** artifact, containing:

- `Okou-Swift-macos-arm64.zip`: the Apple silicon `Okou Dev.app` bundle.
- `Okou-Swift-Project.zip`: a self-contained source tree with this Swift package,
  both native helpers, app icons, pinned dependencies, and packaging scripts.
- `Okou-Swift-Desktop.png`: the settings window rendered by the packaged app.

Artifacts expire after 30 days. The PR source remains available in GitHub.
The app uses the `ai.okou.desktop.dev` development identity against
`https://app.okou.ai`, so it can be installed beside the production app. It is
ad-hoc signed and is not notarized; Gatekeeper may require approving it in
System Settings. Preview builds do not install production updates.

## Open and build

Requirements: Apple silicon Mac, macOS 14+, Xcode 26+ / Swift 6.2+, and the
Xcode command-line tools. Microphone capture requires macOS 15+.

Open `native/swift-desktop/Package.swift` in Xcode from the downloaded project.
The package is the Swift project; an XcodeGen step is not required. Build and run
the packaged app for URL callbacks, menu bar behavior, and macOS permissions:

```sh
bash native/swift-desktop/scripts/build.sh
open 'native/swift-desktop/out/Okou Dev.app'
```

From the repository:

```sh
bash turbo/apps/desktop/native/swift-desktop/scripts/build.sh
```

`--platform-url <url>`, `--product okou|zero`, `--version <version>`, `--output
<directory>`, and `--production` select the packaging configuration. Production
packaging here remains ad-hoc signed; it does not publish a release. Signed
release promotion and its compatibility audit remain separate acceptance work.

Protected staging/PR environments also require their preview access credential.
Supply it at launch through `OKOU_DESKTOP_PREVIEW_BYPASS` after building with the
actual preview `--platform-url`. It is read from the process environment, never
written into the bundle or preferences, and accepted only for preview service
origins (or a local integration-test origin). Authentication pages receive
host-scoped, one-hour cookies; API credentials are never forwarded through
redirects. Production builds do not read this environment variable.

User-selected filesystem folders, MCP configurations, keep-awake preference,
and installation ID use the existing `desktop-preferences.json` format in the
identity's Application Support directory. WebKit has its own cookie store;
the first launch needs sign-in again rather than attempting to import encrypted
Chromium credentials.

MCP stdio servers use their configured executables and the user's login-shell
PATH. A server implemented in Node or Python still needs that runtime installed
by its owner; the Desktop application itself does not embed either runtime.

## Verification

```sh
swift test --package-path native/swift-desktop
swift test --package-path native/computer-use-helper
bash native/swift-desktop/scripts/build.sh
'native/swift-desktop/out/Okou Dev.app/Contents/MacOS/okou-desktop' --smoke-test
```

The core integration tests also run on Linux. macOS CI compiles the actual
SwiftUI/WebKit/MCP app, tests both Swift packages, packages and verifies the
ad-hoc signature, launches the packaged executable, and uploads the ZIPs and window image.
Core tests alone do not verify UI behavior, TCC permissions, live authentication,
recording delivery, or signed self-update installation.

The filesystem editing behavior is ported from
`@modelcontextprotocol/server-filesystem@2026.1.14`; its MIT notice is retained in
`Resources/filesystem-server-LICENSE.txt`. The jsdiff line/patch port and
brace-expansion range behavior retain their BSD/MIT notices in `Resources`.
The packaged app includes these notices and licenses from all resolved Swift
dependencies.

To regenerate the filesystem reference cases, unpack the pinned filesystem
server package into a separate directory and install its dependencies there
with `npm install --ignore-scripts`. Then pass that package directory to
`scripts/generate-filesystem-fixtures.mjs`. This Node script only generates test
reference data; it is not used to build or run the native application.
