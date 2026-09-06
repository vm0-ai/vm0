import Foundation

/// WHATWG-flavoured URL helpers.
///
/// The Electron main process reasons about URLs with the browser `URL` class:
/// lowercase scheme and host, default ports dropped, an empty path serialized
/// as `/`, and an `origin` tuple that only exists for http(s). Foundation's
/// `URL` is RFC 3986 flavoured, so the few semantics the desktop depends on are
/// reproduced here rather than sprinkled across call sites.
public enum DesktopURL {
    public static let defaultPorts: [String: Int] = ["http": 80, "https": 443]

    public static func parse(_ rawURL: String) -> URLComponents? {
        guard let components = URLComponents(string: rawURL), let scheme = components.scheme,
            !scheme.isEmpty
        else {
            return nil
        }
        return components
    }

    /// `scheme://host[:port]` for http(s) URLs; `nil` for every other scheme,
    /// matching the browser's opaque `"null"` origin.
    public static func origin(_ components: URLComponents) -> String? {
        guard let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            return nil
        }
        if let port = components.port, port != defaultPorts[scheme] {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    public static func origin(_ rawURL: String) -> String? {
        guard let components = parse(rawURL) else { return nil }
        return origin(components)
    }

    public static func origin(_ url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        return origin(components)
    }

    /// The pathname as the browser reports it: `/` when empty.
    public static func pathname(_ components: URLComponents) -> String {
        components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
    }

    public static func pathname(_ url: URL) -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return "/"
        }
        return pathname(components)
    }

    public static func scheme(_ components: URLComponents) -> String {
        components.scheme?.lowercased() ?? ""
    }

    public static func hostname(_ components: URLComponents) -> String {
        components.host?.lowercased() ?? ""
    }

    /// Returns the first query value for `name`, percent-decoded, like
    /// `URLSearchParams.get`.
    public static func queryValue(_ components: URLComponents, _ name: String) -> String? {
        components.queryItems?.first(where: { $0.name == name })?.value
    }

    /// Serializes the components the way the browser would: lowercase scheme
    /// and host, default port dropped, empty path rendered as `/`.
    public static func serialize(_ components: URLComponents) -> String {
        var normalized = components
        normalized.scheme = components.scheme?.lowercased()
        normalized.host = components.host?.lowercased()
        if let scheme = normalized.scheme, let port = normalized.port, defaultPorts[scheme] == port {
            normalized.port = nil
        }
        if normalized.percentEncodedPath.isEmpty, normalized.host != nil {
            normalized.percentEncodedPath = "/"
        }
        return normalized.string ?? ""
    }

    public static func serialize(_ url: URL) -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        return serialize(components)
    }

    /// Builds `new URL(path, base)` for an absolute path: the base's origin
    /// with the given path, query and fragment.
    public static func resolve(path: String, query: [(String, String)] = [], against base: URL) -> String {
        var components = URLComponents()
        components.scheme = base.scheme?.lowercased()
        components.host = base.host?.lowercased()
        if let port = base.port, defaultPorts[components.scheme ?? ""] != port {
            components.port = port
        }
        components.percentEncodedPath = path
        if !query.isEmpty {
            components.percentEncodedQuery = encodeQuery(query)
        }
        return components.string ?? ""
    }

    private static let queryUnreserved: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    /// `application/x-www-form-urlencoded` style query serialization.
    public static func encodeQuery(_ items: [(String, String)]) -> String {
        items.map { name, value in
            "\(encodeQueryComponent(name))=\(encodeQueryComponent(value))"
        }.joined(separator: "&")
    }

    public static func encodeQueryComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: queryUnreserved) ?? value
    }
}
