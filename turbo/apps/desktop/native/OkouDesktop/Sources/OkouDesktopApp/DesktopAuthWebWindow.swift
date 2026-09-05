#if canImport(AppKit)
import AppKit
import CryptoKit
import OkouDesktopKit
import WebKit

/// The persistent WebKit cookie/storage jar for one desktop environment,
/// the counterpart of the Electron `persist:vm0-desktop-<env>` partition.
enum DesktopWebsiteDataStore {
    static func identifier(for partition: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data(partition.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x40
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    @MainActor
    static func store(for partition: String) -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: identifier(for: partition))
    }

    /// Everything the Electron sign-out clears: cookies, local storage,
    /// IndexedDB, service workers and caches.
    @MainActor
    static func clearSignOutStorage(_ store: WKWebsiteDataStore) async {
        let types: Set<String> = [
            WKWebsiteDataTypeCookies, WKWebsiteDataTypeLocalStorage, WKWebsiteDataTypeIndexedDBDatabases,
            WKWebsiteDataTypeServiceWorkerRegistrations, WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache,
        ]
        await store.removeData(ofTypes: types, modifiedSince: .distantPast)
    }
}

/// Reads the WebKit jar for URLSession requests.
final class WebKitSessionCookieSource: DesktopSessionCookieSource, @unchecked Sendable {
    private let store: WKWebsiteDataStore

    init(store: WKWebsiteDataStore) {
        self.store = store
    }

    func cookies(for url: URL) async -> [DesktopSessionCookie] {
        let all = await Task { @MainActor in await store.httpCookieStore.allCookies() }.value
        return all.filter {
            DesktopSessionCookies.cookieMatches(domain: $0.domain, path: $0.path, isSecure: $0.isSecure, url: url)
        }.map { DesktopSessionCookie(name: $0.name, value: $0.value) }
    }
}

/// One hidden or visible WebKit window driving a `desktop-auth` page. Port
/// of `runAuthWindow` + `waitForAuthConsumeWindow` + the consume window
/// navigation policy. The token arrives out of band through the injected
/// `window.vm0DesktopAuth.completeSignIn` bridge.
@MainActor
final class DesktopAuthWebWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, NSWindowDelegate {
    static let timeoutSeconds: Double = 30
    static let bridgeName = "vm0DesktopAuth"
    static let bridgeScript = """
        (function () {
          if (window.vm0DesktopAuth) { return; }
          window.vm0DesktopAuth = {
            completeSignIn: function (params) {
              return window.webkit.messageHandlers.vm0DesktopAuth.postMessage({
                type: "completeSignIn",
                token: params && params.token
              });
            }
          };
        })();
        """

    private let config: DesktopConfig
    private let request: DesktopAuthWindowRequest
    private let onCompleteSignIn: (String) -> Void
    private let openExternal: (String) -> Void
    private var window: NSWindow!
    private var webView: WKWebView!
    private var continuation: CheckedContinuation<Void, Error>? = nil
    private var timeoutTask: Task<Void, Never>? = nil
    private var settled = false
    private var retainedSelf: DesktopAuthWebWindow? = nil

    init(
        config: DesktopConfig, request: DesktopAuthWindowRequest, dataStore: WKWebsiteDataStore,
        onCompleteSignIn: @escaping (String) -> Void, openExternal: @escaping (String) -> Void
    ) {
        self.config = config
        self.request = request
        self.onCompleteSignIn = onCompleteSignIn
        self.openExternal = openExternal
        super.init()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: Self.bridgeName)
        let size = NSSize(width: request.visible ? 520 : 480, height: 640)
        let webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        self.webView = webView

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = config.identity.displayName
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(srgbRed: 0x19 / 255, green: 0x19 / 255, blue: 0x1b / 255, alpha: 1)
        window.contentView = webView
        window.delegate = self
        window.center()
        self.window = window
    }

    static func run(
        config: DesktopConfig, request: DesktopAuthWindowRequest, dataStore: WKWebsiteDataStore,
        onCompleteSignIn: @escaping (String) -> Void, openExternal: @escaping (String) -> Void
    ) async throws {
        let authWindow = DesktopAuthWebWindow(
            config: config, request: request, dataStore: dataStore, onCompleteSignIn: onCompleteSignIn, openExternal: openExternal
        )
        try await authWindow.start()
    }

    private func start() async throws {
        retainedSelf = self
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.continuation = continuation
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.timeoutSeconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.reject(DesktopAuthError("Desktop auth consume timed out"))
            }
            if request.visible {
                showAndFocus()
            }
            guard let url = URL(string: request.url) else {
                reject(DesktopAuthError("Desktop auth URL is invalid: \(request.url)"))
                return
            }
            webView.load(URLRequest(url: url))
        }
    }

    private func showAndFocus() {
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    private func settle(_ result: Result<Void, Error>) {
        guard !settled else { return }
        settled = true
        timeoutTask?.cancel()
        timeoutTask = nil
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.bridgeName, contentWorld: .page)
        window.delegate = nil
        window.close()
        let continuation = self.continuation
        self.continuation = nil
        retainedSelf = nil
        continuation?.resume(with: result)
    }

    private func resolve() {
        settle(.success(()))
    }

    private func reject(_ error: Error) {
        settle(.failure(error))
    }

    private func openExternalIfAllowed(_ rawUrl: String) {
        if case let .openExternal(url) = DesktopWindowPolicy.decideWindowOpen(rawUrl, allowedAppOrigins: []) {
            openExternal(url)
        }
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let rawUrl = navigationAction.request.url?.absoluteString ?? ""
        guard let targetFrame = navigationAction.targetFrame else {
            // A popup (Google OAuth, help links) goes to the system browser.
            openExternalIfAllowed(rawUrl)
            decisionHandler(.cancel)
            return
        }
        guard targetFrame.isMainFrame else {
            decisionHandler(.allow)
            return
        }
        if DesktopWindowPolicy.isAllowedAppNavigation(rawUrl, allowedAppOrigins: config.allowedAppOrigins) {
            decisionHandler(.allow)
            return
        }
        // Electron only intercepts page-initiated navigations; server
        // redirects pass through. WebKit cannot tell the two apart here, so
        // link clicks leave the window while redirects are allowed to land.
        if navigationAction.navigationType == .linkActivated {
            openExternalIfAllowed(rawUrl)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        handleNavigation(webView.url?.absoluteString ?? "")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        handleNavigation(webView.url?.absoluteString ?? "")
    }

    private func handleNavigation(_ rawUrl: String) {
        let origins = config.allowedAppOrigins
        if !request.allowInteractiveFallbacks, DesktopAuthURLs.isStartNavigation(rawUrl, allowedAppOrigins: origins) {
            resolve()
            return
        }
        if DesktopAuthURLs.isSelectOrgNavigation(rawUrl, allowedAppOrigins: origins) {
            if request.allowInteractiveFallbacks {
                showAndFocus()
            } else {
                resolve()
            }
            return
        }
        if DesktopAuthURLs.isCompletionNavigation(rawUrl, allowedAppOrigins: origins) {
            resolve()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    private func handleLoadFailure(_ error: Error) {
        let nsError = error as NSError
        // Cancelled loads are the WebKit counterpart of Electron's ERR_ABORTED.
        // WKErrorFrameLoadInterruptedByPolicyChange (102) follows a cancelled policy decision.
        if nsError.code == NSURLErrorCancelled || (nsError.domain == WKError.errorDomain && nsError.code == 102) {
            return
        }
        reject(DesktopAuthError("Desktop auth consume failed: \(nsError.code) \(nsError.localizedDescription)"))
    }

    // MARK: WKUIDelegate

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        openExternalIfAllowed(navigationAction.request.url?.absoluteString ?? "")
        return nil
    }

    // MARK: WKScriptMessageHandlerWithReply

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        var originString = "\(origin.protocol)://\(origin.host)"
        if origin.port != 0, DesktopURL.defaultPorts[origin.protocol] != origin.port {
            originString += ":\(origin.port)"
        }
        guard config.allowedAppOrigins.contains(originString) else {
            replyHandler(nil, "Desktop auth completion is unavailable on this page")
            return
        }
        guard let body = message.body as? [String: Any], let token = body["token"] as? String, !token.isEmpty else {
            replyHandler(nil, "Desktop auth completion requires a token")
            return
        }
        onCompleteSignIn(token)
        replyHandler(nil, nil)
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        reject(DesktopAuthError("Desktop auth consume window closed"))
    }
}
#endif
