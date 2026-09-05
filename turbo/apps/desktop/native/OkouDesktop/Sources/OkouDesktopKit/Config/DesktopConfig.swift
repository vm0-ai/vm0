import Foundation

public enum DesktopEnvironment: String, Sendable {
    case production
    case staging
    case development
}

public struct DesktopRuntimeConfig: Equatable, Sendable {
    public static let fileName = "desktop-runtime-config.json"

    public let platformUrl: String
    public let product: DesktopProduct?

    public init(platformUrl: String, product: DesktopProduct?) {
        self.platformUrl = platformUrl
        self.product = product
    }

    /// Parses the packaged runtime configuration. Mirrors `parseRuntimeConfig`
    /// in `config.ts`, including its error messages.
    public static func parse(_ value: JSONValue) throws -> DesktopRuntimeConfig {
        guard let object = value.objectValue, let rawPlatformUrl = object["platformUrl"],
            let platformUrl = rawPlatformUrl.stringValue
        else {
            throw DesktopConfigError("\(fileName) must contain a platformUrl string")
        }
        var product: DesktopProduct? = nil
        if let rawProduct = object["product"] {
            guard let productName = rawProduct.stringValue else {
                throw DesktopConfigError("\(fileName) product must be zero or okou")
            }
            product = try desktopProduct(productName)
        }
        return DesktopRuntimeConfig(platformUrl: platformUrl, product: product)
    }

    public static func read(at fileURL: URL) throws -> DesktopRuntimeConfig? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }
        let data = try Data(contentsOf: fileURL)
        return try parse(try JSONValue.parse(data))
    }
}

public struct DesktopConfigError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

public struct DesktopConfig: Equatable, Sendable {
    public let platformUrl: URL
    public let webUrl: URL
    public let environment: DesktopEnvironment
    public let identity: DesktopIdentity
    /// Name of the isolated cookie/storage jar, `persist:vm0-desktop-<env>`.
    public let sessionPartition: String
    public let allowedAppOrigins: Set<String>

    public var apiBaseUrl: String {
        resolveComputerUseApiBaseUrl(platformUrl)
    }
}

func desktopProduct(_ value: String) throws -> DesktopProduct {
    guard let product = DesktopProduct(rawValue: value) else {
        throw DesktopConfigError("Unsupported desktop product: \(value)")
    }
    return product
}

/// `readDesktopEnvironment`: trimmed, empty strings collapse to nil.
public func readDesktopEnvironment(_ key: String, environment: [String: String]) -> String? {
    guard let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
    else {
        return nil
    }
    return value
}

private func isLocalHost(_ hostname: String) -> Bool {
    hostname == "localhost" || hostname == "127.0.0.1"
}

func deriveCompanionUrl(_ platformUrl: URL, target: DesktopServiceTarget) -> URL {
    var components = URLComponents(url: platformUrl, resolvingAgainstBaseURL: false)!
    let hostname = DesktopURL.hostname(components)
    if isLocalHost(hostname) {
        if components.port == 3002 {
            components.port = target == .www ? 3000 : 3001
        }
    } else {
        components.host = DesktopServiceHostname.rewrite(hostname, target: target)
    }
    components.percentEncodedPath = "/"
    components.query = nil
    components.fragment = nil
    return URL(string: DesktopURL.serialize(components))!
}

private func allowedOriginsForPlatformUrl(_ platformUrl: URL) -> Set<String> {
    var origins = Set<String>()
    if let origin = DesktopURL.origin(platformUrl) {
        origins.insert(origin)
    }
    for target in [DesktopServiceTarget.www, .api] {
        if let origin = DesktopURL.origin(deriveCompanionUrl(platformUrl, target: target)) {
            origins.insert(origin)
        }
    }
    return origins
}

private func parsePlatformUrl(_ rawUrl: String?, product: DesktopProduct) throws -> URL {
    let trimmed = rawUrl?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let value = trimmed.isEmpty ? DesktopIdentities.defaultPlatformUrl(for: product) : trimmed
    guard let components = DesktopURL.parse(value), components.host != nil,
        let url = URL(string: DesktopURL.serialize(components))
    else {
        throw DesktopConfigError("Invalid URL: \(value)")
    }
    let scheme = DesktopURL.scheme(components)
    guard scheme == "https" || scheme == "http" else {
        throw DesktopConfigError("OKOU_DESKTOP_PLATFORM_URL must use http or https, received \(scheme):")
    }
    return url
}

private func environmentForPlatformUrl(_ platformUrl: URL, hasExplicitUrl: Bool) -> DesktopEnvironment {
    let hostname = platformUrl.host?.lowercased() ?? ""
    if !hasExplicitUrl || hostname == "app.vm0.ai" || hostname == "app.okou.ai" {
        return .production
    }
    if hostname == "staging-app.omby.ai" {
        return .staging
    }
    return .development
}

/// Resolves the effective desktop configuration.
///
/// Precedence matches `resolveDesktopConfig` in `config.ts`: an explicit
/// argument wins over the `OKOU_DESKTOP_PRODUCT` / `OKOU_DESKTOP_PLATFORM_URL`
/// environment, which wins over the packaged runtime config, which wins over
/// the product default. A platform URL argument that is present but empty
/// deliberately short-circuits the environment and file.
public func resolveDesktopConfig(
    rawPlatformUrl: String? = nil,
    rawProduct: String? = nil,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    runtimeConfig: DesktopRuntimeConfig? = nil
) throws -> DesktopConfig {
    let productName =
        nonEmpty(rawProduct?.trimmingCharacters(in: .whitespacesAndNewlines))
        ?? readDesktopEnvironment("OKOU_DESKTOP_PRODUCT", environment: environment)
        ?? runtimeConfig?.product?.rawValue
        ?? "okou"
    let product = try desktopProduct(productName)

    let platformUrlSource: String?
    if let rawPlatformUrl {
        platformUrlSource = rawPlatformUrl
    } else {
        platformUrlSource =
            readDesktopEnvironment("OKOU_DESKTOP_PLATFORM_URL", environment: environment)
            ?? runtimeConfig?.platformUrl
    }
    let hasExplicitUrl = !(platformUrlSource?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty
    let platformUrl = try parsePlatformUrl(platformUrlSource, product: product)
    let environmentKind = environmentForPlatformUrl(platformUrl, hasExplicitUrl: hasExplicitUrl)

    return DesktopConfig(
        platformUrl: platformUrl,
        webUrl: deriveCompanionUrl(platformUrl, target: .www),
        environment: environmentKind,
        identity: DesktopIdentities.identity(
            product: product,
            kind: environmentKind == .production ? .production : .development
        ),
        sessionPartition: "persist:vm0-desktop-\(environmentKind.rawValue)",
        allowedAppOrigins: allowedOriginsForPlatformUrl(platformUrl)
    )
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
