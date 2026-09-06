import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DesktopSessionCookie: Equatable, Sendable {
    public let name: String
    public let value: String

    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }
}

/// The WebKit cookie jar as seen from URLSession requests.
public protocol DesktopSessionCookieSource: Sendable {
    /// Cookies that would be sent to `url`.
    func cookies(for url: URL) async -> [DesktopSessionCookie]
}

public enum DesktopSessionCookies {
    /// Merges cookies for the URLs in order so later URLs win on name
    /// collision, then joins them into one `cookie` header value.
    public static func cookieHeader(source: DesktopSessionCookieSource, urls: [URL]) async -> String {
        var order: [String] = []
        var pairs: [String: String] = [:]
        for url in urls {
            for cookie in await source.cookies(for: url) {
                if pairs[cookie.name] == nil {
                    order.append(cookie.name)
                }
                pairs[cookie.name] = "\(cookie.name)=\(cookie.value)"
            }
        }
        return order.compactMap { pairs[$0] }.joined(separator: "; ")
    }

    /// Whether a stored cookie applies to a request URL, mirroring the
    /// browser's domain, path and secure matching.
    public static func cookieMatches(domain: String, path: String, isSecure: Bool, url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        let cookieDomain = domain.lowercased().hasPrefix(".") ? String(domain.lowercased().dropFirst()) : domain.lowercased()
        let domainMatches = host == cookieDomain || host.hasSuffix("." + cookieDomain)
        guard domainMatches else { return false }
        let requestPath = DesktopURL.pathname(url)
        let cookiePath = path.isEmpty ? "/" : path
        let pathMatches = requestPath == cookiePath || requestPath.hasPrefix(cookiePath.hasSuffix("/") ? cookiePath : cookiePath + "/")
        guard pathMatches else { return false }
        if isSecure, url.scheme?.lowercased() != "https" {
            return false
        }
        return true
    }
}

extension URLRequest {
    /// Adds the merged session cookies, the bearer token and the client headers.
    public mutating func applyDesktopSessionHeaders(
        cookieHeader: String, token: String?, clientHeaders: DesktopClientHeaders
    ) {
        if !cookieHeader.isEmpty {
            setValue(cookieHeader, forHTTPHeaderField: "cookie")
        }
        if let token {
            setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        clientHeaders.apply(to: &self)
    }
}
