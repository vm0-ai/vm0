import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct DesktopRelease: Sendable, Equatable {
  public let version: String
  public let archiveURL: URL
}

/// The update feed has no dependency on preferences, login, or the host runtime.
/// Bootstrap can therefore fetch a repaired build when those components fail.
@MainActor
public final class DesktopUpdateFeed {
  private let url: URL
  private let session: URLSession

  public init(url: URL, session: URLSession = URLSession(configuration: .ephemeral)) {
    self.url = url
    self.session = session
  }

  public func latest(after version: String) async throws -> DesktopRelease? {
    let (data, response) = try await session.data(for: URLRequest(url: url, timeoutInterval: 30))
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw DesktopFailure("update_feed", "Could not check for desktop updates")
    }
    let feed = try JSONDecoder().decode(Feed.self, from: data)
    guard
      feed.currentRelease.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression)
        != nil
    else {
      throw DesktopFailure("update_feed", "The stable feed returned an invalid release version")
    }
    guard feed.currentRelease.compare(version, options: .numeric) == .orderedDescending else {
      return nil
    }
    guard let release = feed.releases.first(where: { $0.version == feed.currentRelease }) else {
      throw DesktopFailure("update_feed", "The update feed did not include its current release")
    }
    let expected =
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v\(release.version)/Okou-darwin-arm64-\(release.version).zip"
    guard release.updateTo.url.absoluteString == expected else {
      throw DesktopFailure("update_feed", "The update does not belong to this desktop product")
    }
    return DesktopRelease(version: release.version, archiveURL: release.updateTo.url)
  }

  private struct Feed: Decodable {
    let currentRelease: String
    let releases: [Release]
  }
  private struct Release: Decodable {
    let version: String
    let updateTo: Target
  }
  private struct Target: Decodable { let url: URL }
}
