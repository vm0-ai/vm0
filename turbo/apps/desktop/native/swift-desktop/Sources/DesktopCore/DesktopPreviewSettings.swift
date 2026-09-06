import Foundation

public struct DesktopPreviewEnvironment: Codable, Equatable, Sendable {
  public let id: UUID
  public let platformURL: String
  public let apiURL: String?
  public let authURL: String?
  public let bypass: String?

  public init(
    id: UUID = UUID(), platformURL: String, apiURL: String? = nil,
    authURL: String? = nil, bypass: String? = nil
  ) {
    self.id = id
    self.platformURL = platformURL
    self.apiURL = apiURL
    self.authURL = authURL
    self.bypass = bypass
  }
}

/// Preview credentials and runtime state belong to the selected environment.
/// Saving affects the next launch, after the current host and capture drain.
@MainActor
public final class DesktopPreviewSettings {
  public let bundled: DesktopConfiguration
  public let directory: URL
  public private(set) var value: DesktopPreviewEnvironment?
  private var file: URL { directory.appendingPathComponent("desktop-preview.json") }

  public init(bundled: DesktopConfiguration, directory: URL) throws {
    self.bundled = bundled
    self.directory = directory
    let file = directory.appendingPathComponent("desktop-preview.json")
    if FileManager.default.fileExists(atPath: file.path) {
      value = try JSONDecoder().decode(DesktopPreviewEnvironment.self, from: Data(contentsOf: file))
    }
  }

  public func configuration(for environment: DesktopPreviewEnvironment?) throws
    -> DesktopConfiguration
  {
    try DesktopConfiguration(
      platformURL: bundled.platformURL.absoluteString, product: bundled.product,
      version: bundled.version, preview: !bundled.production,
      previewBypass: bundled.previewBypass, previewEnvironment: environment)
  }

  public func runtimeDirectory(for configuration: DesktopConfiguration) -> URL {
    guard let id = configuration.previewEnvironmentID else { return directory }
    return directory.appendingPathComponent("Previews").appendingPathComponent(id.uuidString)
  }

  public func save(_ environment: DesktopPreviewEnvironment?) throws {
    _ = try configuration(for: environment)
    if let environment {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(environment)
      try data.write(to: file, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    } else if FileManager.default.fileExists(atPath: file.path) {
      try FileManager.default.removeItem(at: file)
    }
    value = environment
  }
}
