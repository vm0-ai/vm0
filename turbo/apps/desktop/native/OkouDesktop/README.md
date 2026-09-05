# Okou Desktop (native Swift)

Native Swift rewrite of the Electron desktop shell in `turbo/apps/desktop`.
It keeps the two existing native helpers (`computer-use-helper` and
`screen-recorder-helper`, built from `../computer-use-helper`) as separate
bundled processes with their newline-delimited JSON protocol, and replaces the
Electron main process, preload bridge and React renderer with AppKit, SwiftUI,
URLSession and WebKit.

## Layout

- `Sources/OkouDesktopKit` — Foundation-only port of the main-process logic:
  configuration and identities, auth hand-off URLs, preferences, update feed
  and deferral policy, window policy, Computer Use types and startup gate,
  tray menu state matrix, recorder geometry and window options, plugin
  restart policy. It builds and tests on Linux as well as macOS.
- `Sources/OkouDesktopApp` — the AppKit/SwiftUI shell: application delegate,
  menu-bar item, main window, keep-awake power assertion, quit confirmation,
  URL-scheme handling.
- `Tests/OkouDesktopKitTests` — XCTest ports of the Electron integration
  tests for the pure logic.
- `scripts/build-app-bundle.sh` — assembles `Okou.app` with SwiftPM output,
  helper binaries, icons, `Info.plist` and the packaged runtime config, then
  ad-hoc signs and zips it.

## Build

```bash
swift test --package-path turbo/apps/desktop/native/OkouDesktop
bash turbo/apps/desktop/native/OkouDesktop/scripts/build-app-bundle.sh \
  --out /tmp/okou-swift --product okou --platform-url https://app.okou.ai
```

The `Desktop Native` GitHub Actions workflow runs the same steps on an Apple
silicon runner and uploads `okou-desktop-swift-macos-arm64-unsigned`
containing `Okou-darwin-arm64-swift.zip`. The artifact is ad-hoc signed, so
open it with right-click → Open or clear quarantine with
`xattr -dr com.apple.quarantine Okou.app`.

## Parity status

| Area                                               | Status         |
| -------------------------------------------------- | -------------- |
| Identities, runtime config, API/web URL derivation | Ported, tested |
| Client headers, preferences, installation id       | Ported, tested |
| Auth hand-off URLs and callback parsing            | Ported, tested |
| WebKit auth session (consume, token, select-org)   | Ported         |
| Computer Use host runtime and helper client        | Ported, tested |
| Accessibility snapshot normalization/rendering     | Ported, tested |
| Permissions, automation probing and prompt         | Ported         |
| Tray icon states and menu matrix                   | Ported, tested |
| Keep awake, quit confirmation, app menu            | Ported         |
| Main window (setup wizard, hero, dev panels)       | Ported         |
| Feature switches (developer tools)                 | Ported         |
| Filesystem plugin (native tools)                   | Ported, tested |
| MCP plugin manager (stdio, Streamable HTTP)        | Ported, tested |
| Screen recorder windows, controller, delivery      | Ported         |
| Auto-update from the Squirrel JSON feed            | Ported, tested |
| Sentry                                             | Ported         |
