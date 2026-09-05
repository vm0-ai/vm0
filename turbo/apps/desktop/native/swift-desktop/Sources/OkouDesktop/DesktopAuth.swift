import AppKit
import DesktopCore
import WebKit

/// WebKit is used only for the existing Clerk handoff and organization picker.
/// The desktop interface, command runtime, and recording controls are native.
@MainActor
final class DesktopAuth: NSObject, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandlerWithReply, NSWindowDelegate
{
  private let configuration: DesktopConfiguration
  private let preferences: DesktopPreferences
  private var token: String?
  private var refreshTask: Task<String?, any Error>?
  private var window: NSWindow?
  private var webView: WKWebView?
  private var completion: CheckedContinuation<Void, any Error>?
  private var deadline: Task<Void, Never>?
  private var interactive = false
  private var epoch = 0
  var onChange: @MainActor () -> Void = {}
  private(set) var signingIn = false
  private(set) var user: JSON = .null
  private(set) var organization: JSON = .null
  var signedIn: Bool { user["userId"].string != nil }

  init(configuration: DesktopConfiguration, preferences: DesktopPreferences) {
    self.configuration = configuration
    self.preferences = preferences
  }

  func getToken(force: Bool) async throws -> String? {
    if preferences.value["nativeSignedOut"].bool { return nil }
    if !force, let token { return token }
    if let refreshTask { return try await refreshTask.value }
    let before = token
    let task = Task<String?, any Error> {
      try await runWindow(configuration.webPath("desktop-auth/token"), interactive: false)
      return token == before ? nil : token
    }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value
  }

  func refreshIdentity(api: DesktopAPI) async throws {
    let currentEpoch = epoch
    do {
      let user = try await api.request("api/auth/me")
      var org: JSON = .null
      do { org = try await api.request("api/org") } catch let error as DesktopHTTPError
        where error.status == 404
      {
        // Signed in without an active organization.
      }
      guard epoch == currentEpoch else { return }
      self.user = user
      self.organization = org
    } catch let error as DesktopHTTPError where error.status == 401 {
      guard epoch == currentEpoch else { return }
      user = .null
      organization = .null
      token = nil
    }
    onChange()
  }

  func signIn() throws {
    try preferences.update { $0["nativeSignedOut"] = .bool(false) }
    NSWorkspace.shared.open(configuration.signInURL)
  }

  func consume(_ url: URL) async throws -> Bool {
    guard let callback = configuration.callback(url) else { return false }
    try preferences.update { $0["nativeSignedOut"] = .bool(false) }
    var query = [URLQueryItem(name: "code", value: callback.code)]
    if let handoff = callback.handoffID { query.append(.init(name: "handoffId", value: handoff)) }
    signingIn = true
    onChange()
    defer {
      signingIn = false
      onChange()
    }
    try await runWindow(
      configuration.webPath("desktop-auth/consume", query: query), interactive: true)
    return true
  }

  func selectOrganization() async throws {
    try await runWindow(
      configuration.webPath(
        "desktop-auth/select-org", query: [.init(name: "force", value: "true")]), interactive: true)
  }

  func signOut() async throws {
    epoch += 1
    refreshTask?.cancel()
    refreshTask = nil
    finish(.failure(CancellationError()))
    token = nil
    user = .null
    organization = .null
    signingIn = false
    try preferences.update { $0["nativeSignedOut"] = .bool(true) }
    let store = WKWebsiteDataStore.default()
    await store.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    onChange()
  }

  private func runWindow(_ url: URL, interactive: Bool) async throws {
    if completion != nil {
      throw DesktopFailure("auth_busy", "Another sign-in operation is already in progress")
    }
    self.interactive = interactive
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    let controller = WKUserContentController()
    controller.addScriptMessageHandler(self, contentWorld: .page, name: "desktopAuth")
    controller.addUserScript(
      WKUserScript(
        source: """
          Object.defineProperty(window, 'vm0DesktopAuth', {value: Object.freeze({
            completeSignIn: async (params) => window.webkit.messageHandlers.desktopAuth.postMessage(params)
          })});
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    configuration.userContentController = controller
    let view = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 560, height: 720), configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    let window = NSWindow(
      contentRect: view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered,
      defer: false)
    window.title = "\(self.configuration.name) — Sign In"
    window.contentView = view
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.center()
    self.window = window
    webView = view
    let currentEpoch = epoch
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion = continuation
        deadline = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(interactive ? 180 : 30)) } catch { return }
          guard let self, self.epoch == currentEpoch else { return }
          self.finish(
            .failure(DesktopFailure("auth_timeout", "Sign-in timed out. Please try again.")))
        }
        view.load(URLRequest(url: url))
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
    }
  }

  private func finish(_ result: Result<Void, any Error>) {
    let continuation = completion
    completion = nil
    deadline?.cancel()
    deadline = nil
    webView?.configuration.userContentController.removeScriptMessageHandler(
      forName: "desktopAuth", contentWorld: .page)
    webView?.stopLoading()
    webView?.navigationDelegate = nil
    webView?.uiDelegate = nil
    window?.delegate = nil
    window?.close()
    window = nil
    webView = nil
    continuation?.resume(with: result)
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor (Any?, String?) -> Void
  ) {
    guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
      configuration.allowsAuthPage(url), completion != nil,
      let body = message.body as? [String: Any], let token = body["token"] as? String,
      !token.isEmpty
    else {
      replyHandler(nil, "Sign-in completion is not allowed on this page")
      return
    }
    self.token = token
    replyHandler(nil, nil)
    finish(.success(()))
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
    -> WKNavigationActionPolicy
  {
    guard let url = navigationAction.request.url else { return .cancel }
    guard configuration.allowsAuthPage(url) else {
      if ["https", "http", "mailto"].contains(url.scheme), interactive {
        NSWorkspace.shared.open(url)
      }
      return .cancel
    }
    if url.path == "/desktop-auth/start" {
      if interactive { NSWorkspace.shared.open(configuration.signInURL) }
      finish(.success(()))
      return .cancel
    }
    if url.path == "/desktop-auth/select-org" {
      if interactive {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      } else {
        finish(.success(()))
        return .cancel
      }
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let url = webView.url, configuration.allowsAuthPage(url) else { return }
    if url.path == "/"
      || url.path.range(of: "^/(en|de|ja|es)/?$", options: .regularExpression) != nil
    {
      finish(.success(()))
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error)
  { navigationFailed(error) }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: any Error
  ) { navigationFailed(error) }
  private func navigationFailed(_ error: any Error) {
    if (error as NSError).code != NSURLErrorCancelled { finish(.failure(error)) }
  }
  func windowWillClose(_ notification: Notification) { finish(.failure(CancellationError())) }
}
