import Foundation

/// URL construction and parsing for the desktop sign-in hand-off. Port of
/// `desktop-auth.ts`.
public enum DesktopAuthURLs {
    static let authHost = "auth"
    static let callbackPath = "/callback"
    static let consumePath = "/desktop-auth/consume"
    static let selectOrgPath = "/desktop-auth/select-org"
    static let startWebPath = "/desktop-auth/start"
    static let tokenPath = "/desktop-auth/token"
    static let callbackSchemeParam = "callbackScheme"
    static let forceOrgSelectionParam = "force"
    static let codePattern = #/^[A-Za-z0-9_-]{32,128}$/#
    static let handoffIdPattern =
        #/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/#
    static let completionPathPattern = #/^\/(?:en|de|ja|es)\/?$/#
    public static let startRetryMs: Double = 30_000

    /// Exact expected format:
    /// `<authScheme>://auth/callback?code=<32-128 url-safe chars>[&handoffId=<uuid>]`.
    public static func parseCallback(_ rawUrl: String, authScheme: String) -> DesktopAuthCallback? {
        guard let url = DesktopURL.parse(rawUrl) else { return nil }
        let code = DesktopURL.queryValue(url, "code")
        let handoffId = DesktopURL.queryValue(url, "handoffId")
        guard DesktopURL.scheme(url) == authScheme.lowercased(),
            DesktopURL.hostname(url) == authHost,
            DesktopURL.pathname(url) == callbackPath,
            let code, !code.isEmpty, code.firstMatch(of: codePattern) != nil
        else {
            return nil
        }
        if let handoffId, handoffId.firstMatch(of: handoffIdPattern) == nil {
            return nil
        }
        return DesktopAuthCallback(code: code, handoffId: handoffId)
    }

    public static func parseCallback(argv: [String], authScheme: String) -> DesktopAuthCallback? {
        for argument in argv {
            if let callback = parseCallback(argument, authScheme: authScheme) {
                return callback
            }
        }
        return nil
    }

    public static func consumeUrl(webUrl: URL, code: String, handoffId: String? = nil) -> String {
        var query = [("code", code)]
        if let handoffId, !handoffId.isEmpty {
            query.append(("handoffId", handoffId))
        }
        return DesktopURL.resolve(path: consumePath, query: query, against: webUrl)
    }

    public static func selectOrgUrl(webUrl: URL, forceSelection: Bool = false) -> String {
        DesktopURL.resolve(
            path: selectOrgPath,
            query: forceSelection ? [(forceOrgSelectionParam, "true")] : [],
            against: webUrl
        )
    }

    public static func startUrl(webUrl: URL, authScheme: String) -> String {
        DesktopURL.resolve(path: startWebPath, query: [(callbackSchemeParam, authScheme)], against: webUrl)
    }

    public static func tokenUrl(webUrl: URL) -> String {
        DesktopURL.resolve(path: tokenPath, against: webUrl)
    }

    private static func isAllowedNavigation(
        _ rawUrl: String, allowedAppOrigins: Set<String>, matching: (String) -> Bool
    ) -> Bool {
        guard let url = DesktopURL.parse(rawUrl), let origin = DesktopURL.origin(url),
            allowedAppOrigins.contains(origin)
        else {
            return false
        }
        return matching(DesktopURL.pathname(url))
    }

    public static func isStartNavigation(_ rawUrl: String, allowedAppOrigins: Set<String>) -> Bool {
        isAllowedNavigation(rawUrl, allowedAppOrigins: allowedAppOrigins) { $0 == startWebPath }
    }

    public static func isSelectOrgNavigation(_ rawUrl: String, allowedAppOrigins: Set<String>) -> Bool {
        isAllowedNavigation(rawUrl, allowedAppOrigins: allowedAppOrigins) { $0 == selectOrgPath }
    }

    public static func isCompletionNavigation(_ rawUrl: String, allowedAppOrigins: Set<String>) -> Bool {
        isAllowedNavigation(rawUrl, allowedAppOrigins: allowedAppOrigins) { path in
            path == "/" || path.firstMatch(of: completionPathPattern) != nil
        }
    }
}

public struct DesktopAuthCallback: Equatable, Sendable {
    public let code: String
    public let handoffId: String?

    public init(code: String, handoffId: String?) {
        self.code = code
        self.handoffId = handoffId
    }
}

/// Rate limits the "open sign-in in the browser" action to one launch per
/// thirty seconds so a redirect loop cannot spawn tabs.
public final class DesktopAuthStartGate: @unchecked Sendable {
    private let now: () -> Double
    private var openedAtMs: Double? = nil
    private let lock = NSLock()

    public init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.now = now
    }

    public func shouldOpen() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let currentMs = now()
        if let openedAtMs, currentMs - openedAtMs < DesktopAuthURLs.startRetryMs {
            return false
        }
        openedAtMs = currentMs
        return true
    }

    public func suppressRetry() {
        lock.lock()
        defer { lock.unlock() }
        openedAtMs = now()
    }
}
