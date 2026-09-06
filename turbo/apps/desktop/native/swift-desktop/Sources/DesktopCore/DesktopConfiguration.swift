import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct DesktopConfiguration: Sendable {
  public let platformURL: URL
  public let apiURL: URL
  public let webURL: URL
  public let product: String
  public let name: String
  public let bundleID: String
  public let version: String
  public let production: Bool
  public let previewBypass: String?
  public let previewEnvironmentID: UUID?

  public init(
    platformURL: String, product: String = "okou", version: String, preview: Bool = false,
    previewBypass: String? = nil, previewEnvironment: DesktopPreviewEnvironment? = nil
  )
    throws
  {
    guard ["okou", "zero"].contains(product),
      let bundledURL = URL(string: platformURL),
      let source = URLComponents(string: previewEnvironment?.platformURL ?? platformURL),
      let url = source.url,
      ["https", "http"].contains(url.scheme), url.host != nil,
      url.user == nil, url.password == nil
    else {
      throw DesktopFailure("configuration", "Invalid desktop platform URL or product")
    }
    let access = source.queryItems?.filter { $0.name == "x-vercel-protection-bypass" } ?? []
    guard access.count <= 1 else {
      throw DesktopFailure("configuration", "The preview URL contains multiple access tokens")
    }
    let bypass =
      access.first?.value
      ?? (previewEnvironment != nil ? previewEnvironment?.bypass : previewBypass)
    var clean = source
    clean.queryItems = source.queryItems?.filter {
      !["x-vercel-protection-bypass", "x-vercel-set-bypass-cookie"].contains($0.name)
    }
    if clean.queryItems?.isEmpty == true { clean.queryItems = nil }
    clean.fragment = nil
    self.platformURL = clean.url!
    self.product = product
    self.version = version
    let productionIdentity = !preview && ["app.okou.ai", "app.vm0.ai"].contains(bundledURL.host)
    production = productionIdentity && previewEnvironment == nil
    name =
      product == "okou"
      ? (productionIdentity ? "Okou" : "Okou Dev")
      : (productionIdentity ? "Zero Computer Use" : "Zero CU Dev")
    bundleID =
      (product == "okou" ? "ai.okou.desktop" : "ai.vm0.zero.desktop")
      + (productionIdentity ? "" : ".dev")
    apiURL =
      try previewEnvironment?.apiURL.map(Self.previewOrigin)
      ?? Self.serviceURL(url, target: "api")
    webURL =
      try previewEnvironment?.authURL.map(Self.previewOrigin)
      ?? (previewEnvironment == nil
        ? Self.serviceURL(url, target: "www") : Self.origin(url))
    if previewEnvironment != nil {
      for service in [self.platformURL, apiURL, webURL] {
        guard Self.isPreviewOrigin(service) else {
          throw DesktopFailure("configuration", "Use preview App, API and sign-in addresses")
        }
      }
    }
    if let bypass {
      guard preview || previewEnvironment != nil, !production,
        [self.platformURL, apiURL, webURL].allSatisfy(Self.isPreviewOrigin),
        !bypass.isEmpty,
        bypass.unicodeScalars.allSatisfy({ (33...126).contains($0.value) })
      else {
        throw DesktopFailure("configuration", "Preview access requires an explicit preview origin")
      }
    }
    self.previewBypass = bypass
    previewEnvironmentID = previewEnvironment?.id
  }

  private static func origin(_ url: URL) throws -> URL {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw DesktopFailure("configuration", "Invalid preview address")
    }
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    return parts.url!
  }

  private static func previewOrigin(_ value: String) throws -> URL {
    guard let url = URL(string: value), isPreviewOrigin(url),
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/"
    else {
      throw DesktopFailure("configuration", "Use a preview service origin without a path or query")
    }
    return try origin(url)
  }

  private static func isPreviewOrigin(_ url: URL) -> Bool {
    guard let host = url.host, url.user == nil, url.password == nil else { return false }
    if ["127.0.0.1", "localhost", "::1"].contains(host) {
      return ["http", "https"].contains(url.scheme)
    }
    guard url.scheme == "https" else { return false }
    return host.range(
      of: "^(staging|pr-[0-9]+)-(app|api|www)\\.(vm6\\.ai|omby\\.ai)$",
      options: .regularExpression) != nil
      || host.hasSuffix("-okou-app-preview.vm0.workers.dev")
      || host.hasSuffix(".vercel.app") || host.hasSuffix(".pages.dev")
      || (host.hasPrefix("vm0-") && host.hasSuffix(".vm6.ai"))
  }

  public static func serviceURL(_ url: URL, target: String) throws -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let host = url.host
    else {
      throw DesktopFailure("configuration", "Invalid service URL")
    }
    if host == "app.okou.ai" {
      components.host = "\(target).vm0.ai"
    } else if host.range(
      of: "^(staging|pr-[0-9]+)-app-okou-app-preview\\.vm0\\.workers\\.dev$",
      options: .regularExpression) != nil
    {
      let reference = host.replacingOccurrences(
        of: "-app-okou-app-preview.vm0.workers.dev", with: "")
      components.host = "\(reference)-\(target).\(target == "api" ? "vm6.ai" : "omby.ai")"
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
    webPath(
      "desktop-auth/start",
      query: [.init(name: "callbackScheme", value: bundleID)] + previewBrowserQuery)
  }

  public func platformPage(query: [URLQueryItem] = []) -> URL {
    var parts = URLComponents(url: platformURL, resolvingAgainstBaseURL: false)!
    parts.path = "/"
    let overrides = Set(query.map(\.name))
    let original = (parts.queryItems ?? []).filter { !overrides.contains($0.name) }
    let items = original + query + previewBrowserQuery
    parts.queryItems = items.isEmpty ? nil : items
    return parts.url!
  }

  private var previewBrowserQuery: [URLQueryItem] {
    guard let previewBypass else { return [] }
    // An external browser has a different cookie store from native WebKit.
    // Renew its preview access when opening the app or delivering a recording.
    return [
      .init(name: "x-vercel-protection-bypass", value: previewBypass),
      .init(name: "x-vercel-set-bypass-cookie", value: "true"),
    ]
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

  public var previewCookies: [HTTPCookie] {
    guard let previewBypass else { return [] }
    let value = previewBypass.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    return Set([apiURL, webURL, platformURL]).map { url in
      var properties: [HTTPCookiePropertyKey: Any] = [
        .name: "x-vercel-protection-bypass", .value: value,
        .domain: url.host!, .path: "/",
        .expires: Date().addingTimeInterval(60 * 60),
      ]
      if url.scheme == "https" { properties[.secure] = "TRUE" }
      return HTTPCookie(properties: properties)!
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
