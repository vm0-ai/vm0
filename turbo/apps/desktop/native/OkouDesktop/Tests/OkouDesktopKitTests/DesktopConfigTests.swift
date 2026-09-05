import XCTest

@testable import OkouDesktopKit

final class DesktopConfigTests: XCTestCase {
    private func config(_ platformUrl: String?, product: String? = nil, env: [String: String] = [:]) throws -> DesktopConfig {
        try resolveDesktopConfig(rawPlatformUrl: platformUrl, rawProduct: product, environment: env, runtimeConfig: nil)
    }

    func testDefaultsToOkouProduction() throws {
        let config = try self.config("")
        XCTAssertEqual(config.platformUrl.absoluteString, "https://app.okou.ai/")
        XCTAssertEqual(config.webUrl.absoluteString, "https://www.vm0.ai/")
        XCTAssertEqual(config.environment, .production)
        XCTAssertEqual(config.identity, DesktopIdentities.identity(product: .okou, kind: .production))
        XCTAssertEqual(config.sessionPartition, "persist:vm0-desktop-production")
        XCTAssertEqual(config.allowedAppOrigins, ["https://api.vm0.ai", "https://app.okou.ai", "https://www.vm0.ai"])
        XCTAssertEqual(config.apiBaseUrl, "https://api.vm0.ai")
    }

    func testZeroProduction() throws {
        let config = try self.config("", product: "zero")
        XCTAssertEqual(config.platformUrl.absoluteString, "https://app.vm0.ai/")
        XCTAssertEqual(config.webUrl.absoluteString, "https://www.vm0.ai/")
        XCTAssertEqual(config.identity, DesktopIdentities.identity(product: .zero, kind: .production))
        XCTAssertEqual(config.allowedAppOrigins, ["https://api.vm0.ai", "https://app.vm0.ai", "https://www.vm0.ai"])
    }

    func testStagingIdentity() throws {
        let config = try self.config("https://staging-app.omby.ai/")
        XCTAssertEqual(config.environment, .staging)
        XCTAssertEqual(config.identity.displayName, "Okou Dev")
        XCTAssertEqual(config.webUrl.absoluteString, "https://staging-www.omby.ai/")
        XCTAssertTrue(config.allowedAppOrigins.contains("https://staging-api.vm6.ai"))
        XCTAssertEqual(config.apiBaseUrl, "https://staging-api.vm6.ai")
    }

    func testPreviewIdentity() throws {
        let config = try self.config("https://pr-123-app.omby.ai/")
        XCTAssertEqual(config.environment, .development)
        XCTAssertEqual(config.identity.bundleId, "ai.okou.desktop.dev")
        XCTAssertEqual(
            config.allowedAppOrigins,
            ["https://pr-123-api.vm6.ai", "https://pr-123-app.omby.ai", "https://pr-123-www.omby.ai"]
        )
    }

    func testCustomPortIsPreserved() throws {
        let config = try self.config("https://app.vm7.ai:8443/")
        XCTAssertEqual(config.webUrl.absoluteString, "https://www.vm7.ai:8443/")
        XCTAssertEqual(config.apiBaseUrl, "https://api.vm7.ai:8443")
        XCTAssertEqual(
            config.allowedAppOrigins,
            ["https://api.vm7.ai:8443", "https://app.vm7.ai:8443", "https://www.vm7.ai:8443"]
        )
    }

    func testLocalhostPorts() throws {
        let config = try self.config("http://localhost:3002")
        XCTAssertEqual(config.platformUrl.absoluteString, "http://localhost:3002/")
        XCTAssertEqual(config.webUrl.absoluteString, "http://localhost:3000/")
        // The API base keeps the platform port; only webUrl and allowedAppOrigins remap localhost ports.
        XCTAssertEqual(config.apiBaseUrl, "http://localhost:3002")
        XCTAssertEqual(config.allowedAppOrigins, ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"])
        XCTAssertEqual(config.environment, .development)
    }

    func testEnvironmentOverridesRuntimeConfig() throws {
        let runtime = DesktopRuntimeConfig(platformUrl: "https://app.okou.ai", product: .okou)
        let config = try resolveDesktopConfig(
            rawPlatformUrl: nil, rawProduct: nil,
            environment: ["OKOU_DESKTOP_PLATFORM_URL": " https://staging-app.omby.ai ", "OKOU_DESKTOP_PRODUCT": "zero"],
            runtimeConfig: runtime
        )
        XCTAssertEqual(config.identity.product, .zero)
        XCTAssertEqual(config.environment, .staging)
    }

    func testExplicitEmptyUrlShortCircuitsEnvironment() throws {
        let config = try resolveDesktopConfig(
            rawPlatformUrl: "", rawProduct: nil,
            environment: ["OKOU_DESKTOP_PLATFORM_URL": "https://staging-app.omby.ai"], runtimeConfig: nil
        )
        XCTAssertEqual(config.environment, .production)
        XCTAssertEqual(config.platformUrl.absoluteString, "https://app.okou.ai/")
    }

    func testRejectsUnsupportedProtocol() {
        XCTAssertThrowsError(try config("ftp://app.okou.ai")) { error in
            XCTAssertEqual(
                (error as? DesktopConfigError)?.message,
                "OKOU_DESKTOP_PLATFORM_URL must use http or https, received ftp:"
            )
        }
    }

    func testRejectsUnknownProduct() {
        XCTAssertThrowsError(try config("", product: "nope")) { error in
            XCTAssertEqual((error as? DesktopConfigError)?.message, "Unsupported desktop product: nope")
        }
    }

    func testRuntimeConfigParsing() throws {
        XCTAssertEqual(
            try DesktopRuntimeConfig.parse(["platformUrl": "https://app.okou.ai", "product": "okou"]),
            DesktopRuntimeConfig(platformUrl: "https://app.okou.ai", product: .okou)
        )
        XCTAssertThrowsError(try DesktopRuntimeConfig.parse(["product": "okou"])) { error in
            XCTAssertEqual(
                (error as? DesktopConfigError)?.message,
                "desktop-runtime-config.json must contain a platformUrl string"
            )
        }
        XCTAssertThrowsError(try DesktopRuntimeConfig.parse(["platformUrl": "https://x", "product": 1])) { error in
            XCTAssertEqual(
                (error as? DesktopConfigError)?.message,
                "desktop-runtime-config.json product must be zero or okou"
            )
        }
    }

    func testIdentitiesMatchElectronJsonSource() throws {
        // The Electron app is the current source of truth for identities; the
        // Swift table must not drift from it while both ship.
        let jsonURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/desktop-identities.json")
        guard FileManager.default.fileExists(atPath: jsonURL.path) else {
            throw XCTSkip("desktop-identities.json is not available at \(jsonURL.path)")
        }
        let document = try JSONValue.parse(try Data(contentsOf: jsonURL))
        for product in DesktopProduct.allCases {
            XCTAssertEqual(
                document[product.rawValue]?["defaultPlatformUrl"]?.stringValue,
                DesktopIdentities.defaultPlatformUrl(for: product)
            )
            for kind in [DesktopIdentityKind.production, .development] {
                let expected = document[product.rawValue]?[kind.rawValue]
                let identity = DesktopIdentities.identity(product: product, kind: kind)
                XCTAssertEqual(expected?["displayName"]?.stringValue, identity.displayName)
                XCTAssertEqual(expected?["userDataDirectoryName"]?.stringValue, identity.userDataDirectoryName)
                XCTAssertEqual(expected?["updateLine"]?.stringValue, identity.updateLine.rawValue)
                XCTAssertEqual(expected?["bundleId"]?.stringValue, identity.bundleId)
                XCTAssertEqual(expected?["authProtocolName"]?.stringValue, identity.authProtocolName)
                XCTAssertEqual(expected?["authScheme"]?.stringValue, identity.authScheme)
                XCTAssertEqual(expected?["brandName"]?.stringValue, identity.brandName.rawValue)
            }
        }
    }

    func testClientHeaders() {
        var counter = 0
        let headers = DesktopClientHeaders(clientVersion: "0.46.12", product: .okou) {
            counter += 1
            return "uuid-\(counter)"
        }
        let first = headers.headers()
        let second = headers.headers()
        XCTAssertEqual(first["X-Client-Version"], "0.46.12")
        XCTAssertEqual(first["X-Client-Type"], "Desktop")
        XCTAssertEqual(first["X-Client-Product"], "okou")
        XCTAssertEqual(first["X-Client-Session-Id"], "uuid-1")
        XCTAssertEqual(first["X-Client-Request-Id"], "uuid-2")
        XCTAssertEqual(second["X-Client-Session-Id"], "uuid-1")
        XCTAssertEqual(second["X-Client-Request-Id"], "uuid-3")
        XCTAssertEqual(DesktopClientHeaders(clientVersion: "1").headers()["X-Client-Product"], "zero")
    }
}
