import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DesktopAuthWindowRequest: Equatable, Sendable {
    public let url: String
    public let visible: Bool
    public let allowInteractiveFallbacks: Bool

    public init(url: String, visible: Bool, allowInteractiveFallbacks: Bool) {
        self.url = url
        self.visible = visible
        self.allowInteractiveFallbacks = allowInteractiveFallbacks
    }
}

public struct DesktopAuthError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// Owns the desktop auth token state machine. Port of `DesktopAuthSession`:
/// the token is delivered out of band by `completeSignIn` from the hidden
/// WebKit window, lives in memory only, and is re-minted through the token
/// page when a request comes back 401.
@MainActor
public final class DesktopAuthSession {
    public static let authMePath = "/api/auth/me"
    public static let orgPath = "/api/org"

    private let apiBaseUrl: String
    private let cookieUrls: [URL]
    private let cookieSource: DesktopSessionCookieSource
    private let http: DesktopHTTPClient
    private let clientHeaders: DesktopClientHeaders
    private let tokenUrl: String
    private let consumeUrl: (String, String?) -> String
    private let selectOrgUrl: String
    private let runAuthWindow: (DesktopAuthWindowRequest) async throws -> Void
    private let onChange: () -> Void
    private let onAuthCompleted: () async throws -> Void

    private var token: String? = nil
    private var refreshTask: Task<String?, Error>? = nil
    private var pendingCallback: DesktopAuthCallback? = nil
    private var signingIn = false
    private var acceptsSignInCompletions = true

    public init(
        apiBaseUrl: String,
        cookieUrls: [URL],
        cookieSource: DesktopSessionCookieSource,
        http: DesktopHTTPClient,
        clientHeaders: DesktopClientHeaders,
        tokenUrl: String,
        consumeUrl: @escaping (String, String?) -> String,
        selectOrgUrl: String,
        runAuthWindow: @escaping (DesktopAuthWindowRequest) async throws -> Void,
        onChange: @escaping () -> Void = {},
        onAuthCompleted: @escaping () async throws -> Void = {}
    ) {
        self.apiBaseUrl = apiBaseUrl
        self.cookieUrls = cookieUrls
        self.cookieSource = cookieSource
        self.http = http
        self.clientHeaders = clientHeaders
        self.tokenUrl = tokenUrl
        self.consumeUrl = consumeUrl
        self.selectOrgUrl = selectOrgUrl
        self.runAuthWindow = runAuthWindow
        self.onChange = onChange
        self.onAuthCompleted = onAuthCompleted
    }

    public var cachedToken: String? {
        token
    }

    public var isSigningIn: Bool {
        signingIn
    }

    public func getToken(forceRefresh: Bool = false) async throws -> String? {
        if !forceRefresh, let token {
            return token
        }
        if !acceptsSignInCompletions {
            return nil
        }
        return try await refresh()
    }

    /// Cookies plus cached bearer; on 401 retries with cookies only, then
    /// once more with a freshly minted token.
    public func fetchWithSessionAuth(
        _ requestUrl: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil
    ) async throws -> DesktopHTTPResponse {
        let response = try await http.send(await request(requestUrl, method: method, headers: headers, body: body))
        if response.status != 401 || token == nil {
            return response
        }
        token = nil
        let withCookies = try await http.send(await request(requestUrl, method: method, headers: headers, body: body))
        if withCookies.status != 401 {
            return withCookies
        }
        guard try await getToken(forceRefresh: true) != nil else {
            return withCookies
        }
        return try await http.send(await request(requestUrl, method: method, headers: headers, body: body))
    }

    public func getAuthState() async throws -> DesktopAuthState {
        if signingIn {
            return .signingIn
        }
        if !acceptsSignInCompletions {
            return .signedOut
        }
        let hadToken = token != nil
        let state = try await fetchAuthState()
        if state != .signedOut || hadToken {
            return state
        }
        guard try await getToken(forceRefresh: true) != nil else {
            return state
        }
        return try await fetchAuthState()
    }

    private func fetchAuthState() async throws -> DesktopAuthState {
        let meResponse = try await fetchWithSessionAuth(URL(string: apiBaseUrl + Self.authMePath)!)
        if meResponse.status == 401 {
            return .signedOut
        }
        guard meResponse.ok else {
            throw DesktopAuthError("Desktop auth status failed: \(meResponse.status)")
        }
        let me = try meResponse.json()
        let user = DesktopAuthUser(userId: me["userId"]?.stringValue ?? "", email: me["email"]?.stringValue ?? "")
        let orgResponse = try await fetchWithSessionAuth(URL(string: apiBaseUrl + Self.orgPath)!)
        if orgResponse.status == 401 {
            return .signedOut
        }
        if orgResponse.status == 404 {
            return .signedIn(user: user, organization: nil)
        }
        guard orgResponse.ok else {
            throw DesktopAuthError("Desktop organization status failed: \(orgResponse.status)")
        }
        let org = try orgResponse.json()
        return .signedIn(
            user: user,
            organization: DesktopAuthOrganization(id: org["id"]?.stringValue ?? "", name: org["name"]?.stringValue ?? "")
        )
    }

    /// The token's only write path; ignored after sign-out until the next
    /// interactive flow re-arms the session.
    public func completeSignIn(token: String) {
        guard acceptsSignInCompletions else { return }
        self.token = token
        onChange()
    }

    public func signOut() {
        token = nil
        refreshTask = nil
        pendingCallback = nil
        signingIn = false
        acceptsSignInCompletions = false
        onChange()
    }

    public func consumeCode(_ code: String, handoffId: String? = nil) async throws {
        acceptsSignInCompletions = true
        setSigningIn(true)
        do {
            try await runAuthWindow(DesktopAuthWindowRequest(url: consumeUrl(code, handoffId), visible: false, allowInteractiveFallbacks: true))
        } catch {
            setSigningIn(false)
            throw error
        }
        setSigningIn(false)
        try await onAuthCompleted()
    }

    public func selectOrganization() async throws {
        acceptsSignInCompletions = true
        try await runAuthWindow(DesktopAuthWindowRequest(url: selectOrgUrl, visible: true, allowInteractiveFallbacks: true))
        try await onAuthCompleted()
    }

    public func consumeCallback(_ callback: DesktopAuthCallback, onError: @escaping (Error) -> Void) {
        Task { @MainActor in
            do {
                try await self.consumeCode(callback.code, handoffId: callback.handoffId)
            } catch {
                onError(error)
            }
        }
    }

    public func queuePendingCallback(_ callback: DesktopAuthCallback) {
        pendingCallback = callback
    }

    public func takePendingCallback() -> DesktopAuthCallback? {
        let callback = pendingCallback
        pendingCallback = nil
        return callback
    }

    private func refresh() async throws -> String? {
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task<String?, Error> { @MainActor in
            try await self.refreshToken()
        }
        refreshTask = task
        defer {
            if refreshTask == task {
                refreshTask = nil
            }
        }
        return try await task.value
    }

    private func refreshToken() async throws -> String? {
        let before = token
        try await runAuthWindow(DesktopAuthWindowRequest(url: tokenUrl, visible: false, allowInteractiveFallbacks: false))
        let after = token
        // A refresh window that completed without delivering a token leaves
        // the token unchanged; report nil rather than resending a stale one.
        return after == before ? nil : after
    }

    private func setSigningIn(_ value: Bool) {
        if signingIn == value { return }
        signingIn = value
        onChange()
    }

    private func request(_ url: URL, method: String, headers: [String: String], body: Data?) async -> URLRequest {
        var request = URLRequest.desktop(url: url, method: method, headers: headers, body: body)
        let cookieHeader = await DesktopSessionCookies.cookieHeader(source: cookieSource, urls: cookieUrls + [url])
        request.applyDesktopSessionHeaders(cookieHeader: cookieHeader, token: token, clientHeaders: clientHeaders)
        return request
    }
}

/// Session-authenticated fetch for the host runtime's `hosts/start` and
/// `/api/auth/me` calls: cookies for the platform URL and the request URL,
/// the cached bearer, and one forced refresh on 401. Port of
/// `createDesktopComputerUseSessionFetch`.
public struct ComputerUseSessionFetch: Sendable {
    public let platformUrl: URL
    public let cookieSource: DesktopSessionCookieSource
    public let http: DesktopHTTPClient
    public let clientHeaders: DesktopClientHeaders
    public let getCachedAuthToken: @Sendable () async -> String?
    public let getAuthToken: @Sendable (Bool) async throws -> String?

    public init(
        platformUrl: URL, cookieSource: DesktopSessionCookieSource, http: DesktopHTTPClient,
        clientHeaders: DesktopClientHeaders,
        getCachedAuthToken: @escaping @Sendable () async -> String?,
        getAuthToken: @escaping @Sendable (Bool) async throws -> String?
    ) {
        self.platformUrl = platformUrl
        self.cookieSource = cookieSource
        self.http = http
        self.clientHeaders = clientHeaders
        self.getCachedAuthToken = getCachedAuthToken
        self.getAuthToken = getAuthToken
    }

    public func send(_ request: URLRequest) async throws -> DesktopHTTPResponse {
        guard let url = request.url else {
            throw DesktopAuthError("Session request is missing a URL")
        }
        let cookieHeader = await DesktopSessionCookies.cookieHeader(source: cookieSource, urls: [platformUrl, url])
        var first = request
        first.applyDesktopSessionHeaders(cookieHeader: cookieHeader, token: await getCachedAuthToken(), clientHeaders: clientHeaders)
        let response = try await http.send(first)
        if response.status != 401 {
            return response
        }
        guard let refreshed = try await getAuthToken(true) else {
            return response
        }
        var retry = request
        retry.applyDesktopSessionHeaders(cookieHeader: cookieHeader, token: refreshed, clientHeaders: clientHeaders)
        return try await http.send(retry)
    }

    public var fetch: DesktopFetch {
        { request in try await send(request) }
    }
}
