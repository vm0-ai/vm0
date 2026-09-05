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
  private var tokenRevision = 0
  private var windowID: UUID?
  private var refresh: (id: UUID, task: Task<String?, any Error>)?
  private var window: NSWindow?
  private var webView: WKWebView?
  private var completion: CheckedContinuation<Void, any Error>?
  private var deadline: Task<Void, Never>?
  private var signedOutProbe: Task<Void, Never>?
  private var interactive = false
  private var epoch = 0
  private var signingOut = false
  private var interactionID: UUID?
  var onChange: @MainActor () -> Void = {}
  private(set) var signingIn = false
  private(set) var user: JSON = .null
  private(set) var organization: JSON = .null
  var signedIn: Bool { user["userId"].string != nil }
  var revision: Int { epoch }

  struct Identity: Equatable {
    let userID: String
    let organizationID: String
  }

  func identity() throws -> Identity {
    try Identity(
      userID: user.requireString("userId"), organizationID: organization.requireString("id"))
  }

  /// Validate the exact bearer against the server before it can own a recording
  /// upload. A refreshed WebKit session may belong to a different workspace.
  func token(for identity: Identity, force: Bool) async throws -> String? {
    let currentEpoch = epoch
    guard let token = try await getToken(force: force) else {
      throw DesktopFailure("signed_out", "Sign in to the recording's workspace to upload it")
    }
    do {
      let verification = DesktopAPI(configuration: configuration)
      let (user, organization) = try await readIdentity(api: verification, token: token)
      try Task.checkCancellation()
      guard epoch == currentEpoch else { throw CancellationError() }
      guard
        try Identity(
          userID: user.requireString("userId"), organizationID: organization.requireString("id"))
          == identity
      else {
        throw DesktopFailure(
          "recording_account_changed",
          "Switch back to the recording's account and workspace to upload it")
      }
      return token
    } catch let error as DesktopHTTPError where error.status == 401 && !force {
      guard epoch == currentEpoch else { throw CancellationError() }
      return try await self.token(for: identity, force: true)
    }
  }

  init(configuration: DesktopConfiguration, preferences: DesktopPreferences) {
    self.configuration = configuration
    self.preferences = preferences
  }

  func getToken(force: Bool) async throws -> String? {
    try Task.checkCancellation()
    if signingOut || preferences.value["nativeSignedOut"].bool { return nil }
    guard !signingIn else {
      throw DesktopFailure("auth_busy", "Finish signing in before continuing")
    }
    if !force, let token { return token }
    if let refresh {
      let value = try await refresh.task.value
      try Task.checkCancellation()
      return value
    }
    let before = tokenRevision
    let currentEpoch = epoch
    let id = UUID()
    let task = Task<String?, any Error> {
      try Task.checkCancellation()
      guard epoch == currentEpoch else { throw CancellationError() }
      try await runWindow(configuration.webPath("desktop-auth/token"), interactive: false)
      try Task.checkCancellation()
      guard epoch == currentEpoch else { throw CancellationError() }
      if tokenRevision == before { token = nil }
      return token
    }
    refresh = (id, task)
    defer { if refresh?.id == id { refresh = nil } }
    let value = try await task.value
    try Task.checkCancellation()
    return value
  }

  func refreshIdentity(api: DesktopAPI) async throws {
    let currentEpoch = epoch
    do {
      let (user, org) = try await refreshedIdentity(api: api, force: false)
      try Task.checkCancellation()
      guard epoch == currentEpoch else { throw CancellationError() }
      self.user = user
      self.organization = org
    } catch let error as DesktopHTTPError where error.status == 401 {
      guard epoch == currentEpoch else { throw CancellationError() }
      user = .null
      organization = .null
      token = nil
    }
    onChange()
  }

  private func refreshedIdentity(api: DesktopAPI, force: Bool) async throws -> (JSON, JSON) {
    let currentEpoch = epoch
    guard let token = try await getToken(force: force) else { return (.null, .null) }
    do {
      return try await readIdentity(api: api, token: token)
    } catch let error as DesktopHTTPError where error.status == 401 && !force {
      guard epoch == currentEpoch else { throw CancellationError() }
      // Renew and retry both requests. Retrying only the organization request
      // can pair the previous user with a newly authenticated workspace.
      return try await refreshedIdentity(api: api, force: true)
    }
  }

  private func readIdentity(api: DesktopAPI, token: String) async throws -> (JSON, JSON) {
    let user = try await api.request("api/auth/me", hostToken: token)
    _ = try user.requireString("userId")
    guard user["email"].string != nil, let orgID = user.object?["orgId"],
      orgID == .null || orgID.string.map({ !$0.isEmpty }) == true
    else { throw DesktopFailure("auth_protocol", "The server returned an invalid account") }
    var organization: JSON = .null
    do {
      organization = try await api.request("api/org", hostToken: token)
      guard try organization.requireString("id") == orgID.string,
        organization["name"].string != nil
      else {
        throw DesktopFailure("auth_protocol", "The server returned an inconsistent workspace")
      }
    } catch let error as DesktopHTTPError where error.status == 404 {
      // The active organization may be absent or have been deleted.
    }
    return (user, organization)
  }

  func signIn() throws {
    guard !signingOut else { throw DesktopFailure("auth_busy", "Sign-out is still in progress") }
    try preferences.update { $0["nativeSignedOut"] = .bool(false) }
    NSWorkspace.shared.open(configuration.signInURL)
  }

  func consume(_ url: URL) async throws -> Bool {
    guard let callback = configuration.callback(url) else { return false }
    let operationID = try beginInteractive()
    defer { endInteractive(operationID) }
    var query = [URLQueryItem(name: "code", value: callback.code)]
    if let handoff = callback.handoffID { query.append(.init(name: "handoffId", value: handoff)) }
    try await runWindow(
      configuration.webPath("desktop-auth/consume", query: query), interactive: true)
    return true
  }

  func selectOrganization() async throws {
    let operationID = try beginInteractive()
    defer { endInteractive(operationID) }
    try await runWindow(
      configuration.webPath(
        "desktop-auth/select-org", query: [.init(name: "force", value: "true")]), interactive: true)
  }

  func signOut() async throws {
    guard !signingOut else { throw DesktopFailure("auth_busy", "Sign-out is still in progress") }
    try preferences.update { $0["nativeSignedOut"] = .bool(true) }
    signingOut = true
    epoch += 1
    refresh?.task.cancel()
    refresh = nil
    finish(.failure(CancellationError()))
    token = nil
    user = .null
    organization = .null
    signingIn = false
    interactionID = nil
    let store = WKWebsiteDataStore.default()
    await store.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    signingOut = false
    onChange()
  }

  private func beginInteractive() throws -> UUID {
    try Task.checkCancellation()
    guard !signingIn, !signingOut else {
      throw DesktopFailure("auth_busy", "Another sign-in operation is already in progress")
    }
    try preferences.update { $0["nativeSignedOut"] = .bool(false) }
    epoch += 1
    refresh?.task.cancel()
    refresh = nil
    finish(.failure(CancellationError()))
    token = nil
    let id = UUID()
    interactionID = id
    signingIn = true
    onChange()
    return id
  }

  private func endInteractive(_ id: UUID) {
    guard interactionID == id else { return }
    interactionID = nil
    signingIn = false
    onChange()
  }

  private func runWindow(_ url: URL, interactive: Bool) async throws {
    try Task.checkCancellation()
    let currentEpoch = epoch
    for cookie in configuration.previewCookies {
      await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
      try Task.checkCancellation()
      guard epoch == currentEpoch else { throw CancellationError() }
    }
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
    if interactive {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    let operationID = UUID()
    windowID = operationID
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion = continuation
        deadline = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(interactive ? 180 : 30)) } catch { return }
          guard let self, self.epoch == currentEpoch, self.windowID == operationID else { return }
          self.finish(
            .failure(DesktopFailure("auth_timeout", "Sign-in timed out. Please try again.")))
        }
        var request = URLRequest(url: url)
        if let bypass = self.configuration.previewBypass {
          request.setValue(bypass, forHTTPHeaderField: "x-vercel-protection-bypass")
        }
        view.load(request)
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        guard let self, self.windowID == operationID else { return }
        self.finish(.failure(CancellationError()))
      }
    }
  }

  private func finish(_ result: Result<Void, any Error>) {
    let continuation = completion
    completion = nil
    windowID = nil
    deadline?.cancel()
    deadline = nil
    signedOutProbe?.cancel()
    signedOutProbe = nil
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
    guard userContentController === webView?.configuration.userContentController,
      message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
      configuration.allowsAuthPage(url), completion != nil,
      let body = message.body as? [String: Any], let token = body["token"] as? String,
      !token.isEmpty
    else {
      replyHandler(nil, "Sign-in completion is not allowed on this page")
      return
    }
    self.token = token
    tokenRevision += 1
    replyHandler(nil, nil)
    // The page still needs this WebView to acknowledge the browser handoff.
    // Its final navigation closes the window after that request completes.
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
    -> WKNavigationActionPolicy
  {
    guard webView === self.webView, let url = navigationAction.request.url else { return .cancel }
    // Clerk may use cross-origin frames. Only a trusted main frame can send
    // the token bridge message; subframe navigation does not grant that right.
    if navigationAction.targetFrame?.isMainFrame == false { return .allow }
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
    guard webView === self.webView, let url = webView.url, configuration.allowsAuthPage(url) else {
      return
    }
    if url.path == "/"
      || url.path.range(of: "^/(en|de|ja|es)/?$", options: .regularExpression) != nil
    {
      finish(.success(()))
    } else if url.path == "/desktop-auth/token", let id = windowID {
      probeSignedOutSession(webView, id: id)
    }
  }

  private func probeSignedOutSession(_ view: WKWebView, id: UUID) {
    signedOutProbe?.cancel()
    signedOutProbe = Task { [weak self, weak view] in
      while !Task.isCancelled {
        guard let self, let view, self.windowID == id else { return }
        do {
          let anonymous =
            try await view.evaluateJavaScript(
              "window.Clerk?.loaded === true && window.Clerk.session === null") as? Bool
          guard !Task.isCancelled, self.windowID == id, self.webView === view,
            view.url?.path == "/desktop-auth/token"
          else { return }
          if anonymous == true {
            // The web token page waits for workspace-list loading even without
            // a session. Complete an anonymous restore once Clerk itself is ready.
            if self.interactive { NSWorkspace.shared.open(self.configuration.signInURL) }
            self.finish(.success(()))
            return
          }
          try await Task.sleep(for: .milliseconds(250))
        } catch {
          guard !Task.isCancelled, self.windowID == id else { return }
          self.finish(.failure(error))
          return
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error)
  { if webView === self.webView { navigationFailed(error) } }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: any Error
  ) { if webView === self.webView { navigationFailed(error) } }
  private func navigationFailed(_ error: any Error) {
    if (error as NSError).code != NSURLErrorCancelled { finish(.failure(error)) }
  }
  func windowWillClose(_ notification: Notification) {
    guard notification.object as? NSWindow === window else { return }
    finish(.failure(CancellationError()))
  }
}
