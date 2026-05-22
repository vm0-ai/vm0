// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ComputerUseHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "computer-use-helper",
            targets: ["ComputerUseHelper"]
        )
    ],
    targets: [
        .executableTarget(
            name: "ComputerUseHelper"
        )
    ]
)
