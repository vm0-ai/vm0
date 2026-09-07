// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ComputerUseHelper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "computer-use-helper",
            targets: ["ComputerUseHelper"]
        ),
        // Screen recording runs as its own process: the Computer Use client
        // kills and respawns its helper on command timeouts, which would
        // destroy an in-flight capture.
        .executable(
            name: "screen-recorder-helper",
            targets: ["ScreenRecorderHelper"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/getsentry/sentry-cocoa.git", from: "9.6.0")
    ],
    targets: [
        .target(
            name: "ComputerUseHelperCore"
        ),
        .executableTarget(
            name: "ComputerUseHelper",
            dependencies: [
                "ComputerUseHelperCore",
                .product(name: "Sentry", package: "sentry-cocoa"),
            ]
        ),
        .target(
            name: "ScreenRecorderCore"
        ),
        .executableTarget(
            name: "ScreenRecorderHelper",
            dependencies: ["ScreenRecorderCore"]
        ),
        .testTarget(
            name: "ComputerUseHelperIntegrationTests",
            dependencies: ["ComputerUseHelper"]
        ),
        .testTarget(
            name: "ComputerUseHelperCoreTests",
            dependencies: ["ComputerUseHelperCore"]
        ),
        .testTarget(
            name: "ScreenRecorderCoreTests",
            dependencies: ["ScreenRecorderCore"]
        ),
    ]
)
