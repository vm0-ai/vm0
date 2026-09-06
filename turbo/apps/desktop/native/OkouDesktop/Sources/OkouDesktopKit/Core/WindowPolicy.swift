import Foundation

public enum WindowOpenDecision: Equatable, Sendable {
    case allowInApp
    case openExternal(url: String)
    case deny
}

/// Navigation policy shared by every desktop window. Port of `window-policy.ts`.
public enum DesktopWindowPolicy {
    static let externalSchemes: Set<String> = ["http", "https", "mailto"]

    public static func isAllowedAppNavigation(_ rawUrl: String, allowedAppOrigins: Set<String>) -> Bool {
        guard let origin = DesktopURL.origin(rawUrl) else { return false }
        return allowedAppOrigins.contains(origin)
    }

    public static func decideWindowOpen(_ rawUrl: String, allowedAppOrigins: Set<String>) -> WindowOpenDecision {
        guard let url = DesktopURL.parse(rawUrl) else {
            return .deny
        }
        if let origin = DesktopURL.origin(url), allowedAppOrigins.contains(origin) {
            return .allowInApp
        }
        if externalSchemes.contains(DesktopURL.scheme(url)) {
            return .openExternal(url: url.string ?? rawUrl)
        }
        return .deny
    }
}
