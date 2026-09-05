// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "OkouDesktop",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "OkouDesktopKit", targets: ["OkouDesktopKit"]),
        // The app executable is assembled into Okou.app by scripts/build-app-bundle.sh.
        .executable(name: "okou-desktop", targets: ["OkouDesktopApp"]),
    ],
    targets: [
        // Pure Foundation port of the Electron main-process logic: config,
        // auth URL handling, Computer Use host runtime, accessibility snapshot
        // shaping, plugin managers, recorder session control, update policy.
        // Dependency free so it type-checks and tests on Linux too.
        .target(
            name: "OkouDesktopKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // AppKit/SwiftUI shell: tray, windows, WebKit auth session, native
        // helper processes, updater.
        .executableTarget(
            name: "OkouDesktopApp",
            dependencies: ["OkouDesktopKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OkouDesktopKitTests",
            dependencies: ["OkouDesktopKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
