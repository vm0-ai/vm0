import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DesktopHTTPResponse: Sendable {
    public let status: Int
    /// Header names lowercased.
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        var lowercased: [String: String] = [:]
        for (name, value) in headers {
            lowercased[name.lowercased()] = value
        }
        self.headers = lowercased
        self.body = body
    }

    public var ok: Bool {
        (200..<300).contains(status)
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }

    public func json() throws -> JSONValue {
        try JSONValue.parse(body)
    }

    public var text: String {
        String(decoding: body, as: UTF8.self)
    }
}

public protocol DesktopHTTPClient: Sendable {
    func send(_ request: URLRequest) async throws -> DesktopHTTPResponse
}

public typealias DesktopFetch = @Sendable (URLRequest) async throws -> DesktopHTTPResponse

/// `fetch` semantics over URLSession: no automatic cookie jar, because the
/// desktop attaches the WebKit session cookies itself.
public final class URLSessionHTTPClient: DesktopHTTPClient, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.httpCookieStorage = nil
            configuration.urlCache = nil
            self.session = URLSession(configuration: configuration)
        }
    }

    public func send(_ request: URLRequest) async throws -> DesktopHTTPResponse {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DesktopConfigError("Non-HTTP response for \(request.url?.absoluteString ?? "request")")
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String {
                headers[name] = value
            }
        }
        return DesktopHTTPResponse(status: http.statusCode, headers: headers, body: data)
    }
}

extension URLRequest {
    public static func desktop(
        url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = body
        return request
    }

    public static func desktopJSON(url: URL, method: String, json: JSONValue, headers: [String: String] = [:]) -> URLRequest {
        var merged = headers
        merged["content-type"] = "application/json"
        return desktop(url: url, method: method, headers: merged, body: json.serializedData())
    }
}
