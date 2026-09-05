import Foundation

public enum DesktopUpdateFeed {
    public static let channel = "stable"
    public static let platform = "darwin"
    public static let arch = "arm64"

    public struct Eligibility: Sendable {
        public let environment: DesktopEnvironment
        public let isPackaged: Bool
        public let platform: String
        public let arch: String

        public init(environment: DesktopEnvironment, isPackaged: Bool, platform: String, arch: String) {
            self.environment = environment
            self.isPackaged = isPackaged
            self.platform = platform
            self.arch = arch
        }
    }

    /// Production, packaged, Apple silicon only. Intel Macs get no updates.
    public static func shouldInstallAutoUpdates(_ eligibility: Eligibility) -> Bool {
        eligibility.environment == .production && eligibility.isPackaged
            && eligibility.platform == platform && eligibility.arch == arch
    }

    /// `{apiBaseUrl}/api/desktop/updates/{line}/stable/darwin/arm64`.
    public static func baseUrl(apiBaseUrl: String, updateLine: DesktopUpdateLine) -> String? {
        guard var components = DesktopURL.parse(apiBaseUrl) else { return nil }
        components.percentEncodedPath =
            "/api/desktop/updates/\(DesktopURL.encodeQueryComponent(updateLine.rawValue))/\(channel)/\(platform)/\(arch)"
        components.query = nil
        components.fragment = nil
        let serialized = DesktopURL.serialize(components)
        return serialized.hasSuffix("/") ? String(serialized.dropLast()) : serialized
    }
}

/// The Squirrel.Mac static-storage feed the API serves at
/// `{baseUrl}/RELEASES.json`.
public struct SquirrelMacReleases: Equatable, Sendable {
    public struct Release: Equatable, Sendable {
        public let version: String
        public let name: String
        public let pubDate: String
        public let url: String
        public let notes: String
    }

    public let currentRelease: String
    public let releases: [Release]

    public static func parse(_ value: JSONValue) throws -> SquirrelMacReleases {
        guard let currentRelease = value["currentRelease"]?.stringValue,
            let rawReleases = value["releases"]?.arrayValue
        else {
            throw DesktopConfigError("RELEASES.json is missing currentRelease or releases")
        }
        let releases = try rawReleases.map { raw -> Release in
            guard let version = raw["version"]?.stringValue, let updateTo = raw["updateTo"],
                let name = updateTo["name"]?.stringValue, let updateVersion = updateTo["version"]?.stringValue,
                let pubDate = updateTo["pub_date"]?.stringValue, let url = updateTo["url"]?.stringValue,
                let notes = updateTo["notes"]?.stringValue
            else {
                throw DesktopConfigError("RELEASES.json contains a malformed release entry")
            }
            return Release(version: version, name: name, pubDate: pubDate, url: url, notes: notes)
                .withVersion(updateVersion)
        }
        return SquirrelMacReleases(currentRelease: currentRelease, releases: releases)
    }

    public var current: Release? {
        releases.first(where: { $0.version == currentRelease })
    }
}

extension SquirrelMacReleases.Release {
    fileprivate func withVersion(_ updateVersion: String) -> SquirrelMacReleases.Release {
        // `version` and `updateTo.version` describe the same release; the
        // outer one is the key Squirrel matches on.
        SquirrelMacReleases.Release(version: version, name: name, pubDate: pubDate, url: url, notes: notes)
    }
}

/// Dotted semantic version comparison used to decide whether a feed entry is
/// newer than the running app.
public struct SemanticVersion: Comparable, Equatable, Sendable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int
    public let prerelease: String?

    public init?(_ text: String) {
        let trimmed = text.hasPrefix("v") ? String(text.dropFirst()) : text
        let core: Substring
        let prerelease: String?
        if let dash = trimmed.firstIndex(of: "-") {
            core = trimmed[..<dash]
            prerelease = String(trimmed[trimmed.index(after: dash)...])
        } else {
            core = Substring(trimmed)
            prerelease = nil
        }
        let parts = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count == 3, let major = parts[0], let minor = parts[1], let patch = parts[2] else {
            return nil
        }
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease
    }

    public var description: String {
        let core = "\(major).\(minor).\(patch)"
        return prerelease.map { "\(core)-\($0)" } ?? core
    }

    public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil): return false
        case (nil, _): return false
        case (_, nil): return true
        case let (left?, right?): return left < right
        }
    }
}
