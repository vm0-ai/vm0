// swift-tools-version: 6.1
import PackageDescription

var dependencies: [Package.Dependency] = []
var products: [Product] = [.library(name: "DesktopCore", targets: ["DesktopCore"])]
var targets: [Target] = [
  .target(name: "DesktopCore"),
  .testTarget(name: "DesktopCoreTests", dependencies: ["DesktopCore"]),
]

#if os(macOS)
  dependencies = [
    .package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", exact: "0.12.1"),
    .package(url: "https://github.com/getsentry/sentry-cocoa.git", exact: "9.17.1"),
  ]
  products.append(.executable(name: "okou-desktop", targets: ["OkouDesktop"]))
  products.append(.executable(name: "okou-desktop-updater", targets: ["DesktopUpdaterHelper"]))
  targets.append(.executableTarget(name: "DesktopUpdaterHelper", dependencies: ["DesktopCore"]))
  targets.append(
    .executableTarget(
      name: "OkouDesktop",
      dependencies: [
        "DesktopCore",
        .product(name: "MCP", package: "swift-sdk"),
        .product(name: "Sentry", package: "sentry-cocoa"),
      ]
    ))
#endif

let package = Package(
  name: "OkouDesktop",
  platforms: [.macOS(.v14)],
  products: products,
  dependencies: dependencies,
  targets: targets
)
