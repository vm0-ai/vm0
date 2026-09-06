import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DesktopUpdateCandidate: Equatable, Sendable {
    public var version: String
    public var name: String
    public var url: String
    public var pubDate: String
    public var notes: String

    public init(version: String, name: String, url: String, pubDate: String, notes: String) {
        self.version = version
        self.name = name
        self.url = url
        self.pubDate = pubDate
        self.notes = notes
    }
}

/// Reads the Squirrel.Mac static feed the API publishes and decides whether
/// `currentRelease` is newer than the running app.
public struct DesktopUpdateChecker: Sendable {
    public let feedBaseUrl: String
    public let currentVersion: String
    public let http: DesktopHTTPClient

    public init(feedBaseUrl: String, currentVersion: String, http: DesktopHTTPClient) {
        self.feedBaseUrl = feedBaseUrl
        self.currentVersion = currentVersion
        self.http = http
    }

    public var releasesUrl: URL {
        URL(string: feedBaseUrl + "/RELEASES.json")!
    }

    public static func candidate(in releases: SquirrelMacReleases, currentVersion: String) -> DesktopUpdateCandidate? {
        guard let release = releases.current, let latest = SemanticVersion(release.version),
            let installed = SemanticVersion(currentVersion), installed < latest
        else {
            return nil
        }
        return DesktopUpdateCandidate(version: release.version, name: release.name, url: release.url, pubDate: release.pubDate, notes: release.notes)
    }

    /// The newer release to download, or nil when up to date.
    public func check() async throws -> DesktopUpdateCandidate? {
        var request = URLRequest.desktop(url: releasesUrl)
        request.setValue("no-cache", forHTTPHeaderField: "cache-control")
        let response = try await http.send(request)
        guard response.ok else {
            throw DesktopConfigError("Desktop update feed responded with HTTP \(response.status)")
        }
        let releases = try SquirrelMacReleases.parse(try response.json())
        return Self.candidate(in: releases, currentVersion: currentVersion)
    }
}
