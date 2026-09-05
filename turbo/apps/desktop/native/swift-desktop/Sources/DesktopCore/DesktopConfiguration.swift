import Foundation

public struct DesktopConfiguration: Sendable {
  public let platformURL: URL
  public let apiURL: URL
  public let webURL: URL
  public let product: String
  public let name: String
  public let bundleID: String
  public let version: String
  public let production: Bool

  public init(platformURL: String, product: String = "okou", version: String, preview: Bool = false)
    throws
  {
    guard ["okou", "zero"].contains(product),
      let url = URL(string: platformURL),
      ["https", "http"].contains(url.scheme), url.host != nil,
      url.user == nil, url.password == nil
    else {
      throw DesktopFailure("configuration", "Invalid desktop platform URL or product")
    }
    self.platformURL = url
    self.product = product
    self.version = version
    production = !preview && ["app.okou.ai", "app.vm0.ai"].contains(url.host)
    name =
      product == "okou"
      ? (production ? "Okou" : "Okou Dev") : (production ? "Zero Computer Use" : "Zero CU Dev")
    bundleID =
      (product == "okou" ? "ai.okou.desktop" : "ai.vm0.zero.desktop") + (production ? "" : ".dev")
    apiURL = try Self.serviceURL(url, target: "api")
    webURL = try Self.serviceURL(url, target: "www")
  }

  public static func serviceURL(_ url: URL, target: String) throws -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let host = url.host
    else {
      throw DesktopFailure("configuration", "Invalid service URL")
    }
    if host == "app.okou.ai" {
      components.host = "\(target).vm0.ai"
    } else {
      var rewritten = host.replacingOccurrences(
        of: "(^|-)(api|app|platform|www)\\.", with: "$1\(target).", options: .regularExpression)
      if target == "api",
        host.range(of: "^(staging|pr-[0-9]+)-app\\.omby\\.ai$", options: .regularExpression) != nil
      {
        rewritten = rewritten.replacingOccurrences(of: ".omby.ai", with: ".vm6.ai")
      }
      components.host = rewritten
    }
    components.path = ""
    components.query = nil
    components.fragment = nil
    guard let result = components.url else {
      throw DesktopFailure("configuration", "Invalid service origin")
    }
    return result
  }

  public func webPath(_ path: String, query: [URLQueryItem] = []) -> URL {
    var parts = URLComponents(
      url: webURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    parts.queryItems = query.isEmpty ? nil : query
    return parts.url!
  }

  public var signInURL: URL {
    webPath("desktop-auth/start", query: [.init(name: "callbackScheme", value: bundleID)])
  }

  public func callback(_ url: URL) -> (code: String, handoffID: String?)? {
    guard url.scheme == bundleID, url.host == "auth", url.path == "/callback",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      let code = items.first(where: { $0.name == "code" })?.value,
      code.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil
    else { return nil }
    let handoff = items.first(where: { $0.name == "handoffId" })?.value
    if let handoff, UUID(uuidString: handoff) == nil { return nil }
    return (code, handoff)
  }

  public func allowsAuthPage(_ url: URL) -> Bool {
    [webURL, platformURL].contains {
      $0.scheme == url.scheme && $0.host == url.host && $0.port == url.port
    }
  }
}

@MainActor
public final class DesktopPreferences {
  public let directory: URL
  public private(set) var value: JSON
  private var file: URL { directory.appendingPathComponent("desktop-preferences.json") }

  public init(directory: URL) throws {
    self.directory = directory
    let file = directory.appendingPathComponent("desktop-preferences.json")
    value =
      FileManager.default.fileExists(atPath: file.path)
      ? try JSON.decode(Data(contentsOf: file)) : .object([:])
    guard value.object != nil else {
      throw DesktopFailure("preferences", "Desktop preferences must be a JSON object")
    }
  }

  public func update(_ edit: (inout JSON) throws -> Void) throws {
    var next = value
    try edit(&next)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try next.encoded(pretty: true).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    value = next
  }

  public func installationID() throws -> String {
    if let id = value["computerUseInstallationId"].string, UUID(uuidString: id) != nil { return id }
    let id = UUID().uuidString.lowercased()
    try update { $0["computerUseInstallationId"] = .string(id) }
    return id
  }
}
