import XCTest

@testable import OkouDesktopKit

final class DesktopAuthURLsTests: XCTestCase {
    private let webUrl = URL(string: "https://www.vm0.ai/")!
    private let code = String(repeating: "a", count: 43)
    private let allowed: Set<String> = ["https://api.vm0.ai", "https://app.okou.ai", "https://www.vm0.ai"]

    func testBuildsHandoffUrls() {
        XCTAssertEqual(
            DesktopAuthURLs.startUrl(webUrl: webUrl, authScheme: "ai.okou.desktop"),
            "https://www.vm0.ai/desktop-auth/start?callbackScheme=ai.okou.desktop"
        )
        XCTAssertEqual(
            DesktopAuthURLs.consumeUrl(webUrl: webUrl, code: code, handoffId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"),
            "https://www.vm0.ai/desktop-auth/consume?code=\(code)&handoffId=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
        )
        XCTAssertEqual(DesktopAuthURLs.consumeUrl(webUrl: webUrl, code: code), "https://www.vm0.ai/desktop-auth/consume?code=\(code)")
        XCTAssertEqual(DesktopAuthURLs.selectOrgUrl(webUrl: webUrl), "https://www.vm0.ai/desktop-auth/select-org")
        XCTAssertEqual(DesktopAuthURLs.selectOrgUrl(webUrl: webUrl, forceSelection: true), "https://www.vm0.ai/desktop-auth/select-org?force=true")
        XCTAssertEqual(DesktopAuthURLs.tokenUrl(webUrl: webUrl), "https://www.vm0.ai/desktop-auth/token")
        let portUrl = URL(string: "https://www.vm7.ai:8443/")!
        XCTAssertEqual(DesktopAuthURLs.tokenUrl(webUrl: portUrl), "https://www.vm7.ai:8443/desktop-auth/token")
    }

    func testParsesCallback() {
        let callback = DesktopAuthURLs.parseCallback(
            "ai.okou.desktop://auth/callback?code=\(code)&handoffId=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
            authScheme: "ai.okou.desktop"
        )
        XCTAssertEqual(callback, DesktopAuthCallback(code: code, handoffId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"))
        XCTAssertEqual(
            DesktopAuthURLs.parseCallback("ai.okou.desktop://auth/callback?code=\(code)", authScheme: "ai.okou.desktop"),
            DesktopAuthCallback(code: code, handoffId: nil)
        )
    }

    func testRejectsMalformedCallbacks() {
        let scheme = "ai.okou.desktop.dev"
        XCTAssertNil(DesktopAuthURLs.parseCallback("ai.okou.desktop.dev://auth/callback?token=secret", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("ai.vm0.zero.desktop://auth/callback?code=\(code)", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("ai.okou.desktop.dev://other/callback?code=\(code)", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("https://www.vm0.ai/desktop-auth/consume?code=\(code)", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("ai.okou.desktop.dev://auth/callback?code=\(code)&handoffId=nope", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("vm0://auth/callback?code=\(code)", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("ai.okou.desktop.dev://auth/callback?code=short", authScheme: scheme))
        XCTAssertNil(DesktopAuthURLs.parseCallback("not a url", authScheme: scheme))
    }

    func testParsesArgv() {
        let callback = DesktopAuthURLs.parseCallback(
            argv: ["/Applications/Okou.app/Contents/MacOS/Okou", "ai.okou.desktop://auth/callback?code=\(code)"],
            authScheme: "ai.okou.desktop"
        )
        XCTAssertEqual(callback?.code, code)
        XCTAssertNil(DesktopAuthURLs.parseCallback(argv: ["--flag"], authScheme: "ai.okou.desktop"))
    }

    func testNavigationClassification() {
        XCTAssertTrue(DesktopAuthURLs.isStartNavigation("https://www.vm0.ai/desktop-auth/start?x=1", allowedAppOrigins: allowed))
        XCTAssertFalse(DesktopAuthURLs.isStartNavigation("https://evil.example/desktop-auth/start", allowedAppOrigins: allowed))
        XCTAssertTrue(DesktopAuthURLs.isSelectOrgNavigation("https://www.vm0.ai/desktop-auth/select-org", allowedAppOrigins: allowed))
        XCTAssertTrue(DesktopAuthURLs.isCompletionNavigation("https://www.vm0.ai/", allowedAppOrigins: allowed))
        XCTAssertTrue(DesktopAuthURLs.isCompletionNavigation("https://www.vm0.ai", allowedAppOrigins: allowed))
        XCTAssertTrue(DesktopAuthURLs.isCompletionNavigation("https://www.vm0.ai/ja/", allowedAppOrigins: allowed))
        XCTAssertFalse(DesktopAuthURLs.isCompletionNavigation("https://www.vm0.ai/pricing", allowedAppOrigins: allowed))
        XCTAssertFalse(DesktopAuthURLs.isCompletionNavigation("https://www.vm0.ai/fr/", allowedAppOrigins: allowed))
    }

    func testStartGate() {
        var nowMs: Double = 1_000
        let gate = DesktopAuthStartGate { nowMs }
        XCTAssertTrue(gate.shouldOpen())
        XCTAssertFalse(gate.shouldOpen())
        nowMs += 29_999
        XCTAssertFalse(gate.shouldOpen())
        nowMs += 1
        XCTAssertTrue(gate.shouldOpen())
        gate.suppressRetry()
        nowMs += 1_000
        XCTAssertFalse(gate.shouldOpen())
    }

    func testWindowPolicy() {
        XCTAssertEqual(DesktopWindowPolicy.decideWindowOpen("https://app.okou.ai/x", allowedAppOrigins: allowed), .allowInApp)
        XCTAssertEqual(
            DesktopWindowPolicy.decideWindowOpen("https://accounts.google.com/o/oauth2", allowedAppOrigins: allowed),
            .openExternal(url: "https://accounts.google.com/o/oauth2")
        )
        XCTAssertEqual(DesktopWindowPolicy.decideWindowOpen("mailto:hi@example.com", allowedAppOrigins: allowed), .openExternal(url: "mailto:hi@example.com"))
        XCTAssertEqual(DesktopWindowPolicy.decideWindowOpen("javascript:alert(1)", allowedAppOrigins: allowed), .deny)
        XCTAssertEqual(DesktopWindowPolicy.decideWindowOpen("", allowedAppOrigins: allowed), .deny)
        XCTAssertTrue(DesktopWindowPolicy.isAllowedAppNavigation("https://API.vm0.ai/", allowedAppOrigins: allowed))
        XCTAssertFalse(DesktopWindowPolicy.isAllowedAppNavigation("https://api.vm0.ai.evil/", allowedAppOrigins: allowed))
    }

    func testApiBaseUrlMappings() {
        let cases: [(String, String)] = [
            ("https://app.vm0.ai", "https://api.vm0.ai"),
            ("https://app.okou.ai", "https://api.vm0.ai"),
            ("https://app.vm7.ai", "https://api.vm7.ai"),
            ("https://staging-app.omby.ai", "https://staging-api.vm6.ai"),
            ("https://pr-123-app.omby.ai", "https://pr-123-api.vm6.ai"),
            ("https://app.vm7.ai:8443/", "https://api.vm7.ai:8443"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(resolveComputerUseApiBaseUrl(URL(string: input)!), expected, input)
        }
    }

    func testUpdateFeed() {
        XCTAssertEqual(
            DesktopUpdateFeed.baseUrl(apiBaseUrl: "https://api.vm0.ai", updateLine: .okou),
            "https://api.vm0.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64"
        )
        XCTAssertEqual(
            DesktopUpdateFeed.baseUrl(apiBaseUrl: "https://api.vm0.ai/?x=1", updateLine: .zero),
            "https://api.vm0.ai/api/desktop/updates/zero/stable/darwin/arm64"
        )
        XCTAssertTrue(
            DesktopUpdateFeed.shouldInstallAutoUpdates(
                DesktopUpdateFeed.Eligibility(environment: .production, isPackaged: true, platform: "darwin", arch: "arm64")
            )
        )
        XCTAssertFalse(
            DesktopUpdateFeed.shouldInstallAutoUpdates(
                DesktopUpdateFeed.Eligibility(environment: .production, isPackaged: true, platform: "darwin", arch: "x64")
            )
        )
        XCTAssertFalse(
            DesktopUpdateFeed.shouldInstallAutoUpdates(
                DesktopUpdateFeed.Eligibility(environment: .staging, isPackaged: true, platform: "darwin", arch: "arm64")
            )
        )
    }

    func testSemanticVersions() {
        XCTAssertTrue(SemanticVersion("0.46.12")! < SemanticVersion("0.47.0")!)
        XCTAssertTrue(SemanticVersion("1.0.0-beta")! < SemanticVersion("1.0.0")!)
        XCTAssertNil(SemanticVersion("1.0"))
        XCTAssertEqual(SemanticVersion("v2.3.4")?.description, "2.3.4")
    }
}

final class UpdateCheckerTests: XCTestCase {
    private let feed = #"{"currentRelease":"0.47.0","releases":[{"version":"0.46.12","updateTo":{"name":"Okou 0.46.12","version":"0.46.12","pub_date":"2026-09-01T00:00:00.000Z","url":"https://example.com/old.zip","notes":""}},{"version":"0.47.0","updateTo":{"name":"Okou 0.47.0","version":"0.47.0","pub_date":"2026-09-05T00:00:00.000Z","url":"https://example.com/Okou-darwin-arm64-0.47.0.zip","notes":"fixes"}}]}"#

    func testCandidateSelection() throws {
        let releases = try SquirrelMacReleases.parse(try JSONValue.parse(feed))
        XCTAssertEqual(
            DesktopUpdateChecker.candidate(in: releases, currentVersion: "0.46.12"),
            DesktopUpdateCandidate(version: "0.47.0", name: "Okou 0.47.0", url: "https://example.com/Okou-darwin-arm64-0.47.0.zip", pubDate: "2026-09-05T00:00:00.000Z", notes: "fixes")
        )
        XCTAssertNil(DesktopUpdateChecker.candidate(in: releases, currentVersion: "0.47.0"))
        XCTAssertNil(DesktopUpdateChecker.candidate(in: releases, currentVersion: "0.48.0"))
        XCTAssertNil(DesktopUpdateChecker.candidate(in: releases, currentVersion: "dev"))
        XCTAssertThrowsError(try SquirrelMacReleases.parse(["releases": []]))
    }

    func testCheckFetchesReleasesJson() async throws {
        struct Client: DesktopHTTPClient {
            let feed: String
            func send(_ request: URLRequest) async throws -> DesktopHTTPResponse {
                XCTAssertEqual(request.url?.absoluteString, "https://api.vm0.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json")
                return DesktopHTTPResponse(status: 200, body: Data(feed.utf8))
            }
        }
        let checker = DesktopUpdateChecker(
            feedBaseUrl: DesktopUpdateFeed.baseUrl(apiBaseUrl: "https://api.vm0.ai", updateLine: .okou)!,
            currentVersion: "0.46.12", http: Client(feed: feed)
        )
        let candidate = try await checker.check()
        XCTAssertEqual(candidate?.version, "0.47.0")
    }
}
