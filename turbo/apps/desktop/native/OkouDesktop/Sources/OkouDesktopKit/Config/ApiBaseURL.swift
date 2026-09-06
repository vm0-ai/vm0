import Foundation

public enum DesktopServiceTarget: String, Sendable {
    case api
    case www
}

/// Hostname rewriting between the platform app origin and its api / www
/// companions. Port of `desktop-api-base-url.ts`.
public enum DesktopServiceHostname {
    private static let cloudflarePreviewAppHostname = #/^(?:staging|pr-[0-9]+)-app\.omby\.ai$/#
    private static let okouProductionAppHostname = "app.okou.ai"
    private static let vm0ProductionServiceHostnames: [DesktopServiceTarget: String] = [
        .api: "api.vm0.ai",
        .www: "www.vm0.ai",
    ]

    private static func replaceHostPrefix(_ hostname: String, target: DesktopServiceTarget) -> String {
        let pattern = #/(^|-)(api|app|platform|www)\./#
        guard let match = hostname.firstMatch(of: pattern) else {
            return hostname
        }
        var rewritten = hostname
        rewritten.replaceSubrange(match.range, with: "\(match.output.1)\(target.rawValue).")
        return rewritten
    }

    public static func rewrite(_ hostname: String, target: DesktopServiceTarget) -> String {
        if hostname == okouProductionAppHostname {
            return vm0ProductionServiceHostnames[target]!
        }
        let rewritten = replaceHostPrefix(hostname, target: target)
        if target != .api || hostname.firstMatch(of: cloudflarePreviewAppHostname) == nil {
            return rewritten
        }
        if rewritten.hasSuffix(".omby.ai") {
            return String(rewritten.dropLast(".omby.ai".count)) + ".vm6.ai"
        }
        return rewritten
    }
}

/// `https://app.okou.ai/` -> `https://api.vm0.ai`; keeps scheme, port and any
/// path, and strips one trailing slash.
public func resolveComputerUseApiBaseUrl(_ platformUrl: URL) -> String {
    guard var components = URLComponents(url: platformUrl, resolvingAgainstBaseURL: false) else {
        return platformUrl.absoluteString
    }
    components.host = DesktopServiceHostname.rewrite(DesktopURL.hostname(components), target: .api)
    let serialized = DesktopURL.serialize(components)
    return serialized.hasSuffix("/") ? String(serialized.dropLast()) : serialized
}
