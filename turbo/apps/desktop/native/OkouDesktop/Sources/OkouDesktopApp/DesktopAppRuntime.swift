#if canImport(AppKit)
import AppKit
import OkouDesktopKit
import WebKit

/// The Swift counterpart of `main.ts`: owns configuration, the auth session,
/// the Computer Use runtime, the tray, the main window, keep-awake and quit.
@MainActor
final class DesktopAppRuntime {
    let config: DesktopConfig
    let appVersion: String
    let userDataDirectory: URL
    let preferences: DesktopPreferencesStore
    let installationId: String
    let assets: DesktopAssetLocator
    let clientHeaders: DesktopClientHeaders
    let authStartGate = DesktopAuthStartGate()
    let shellState: DesktopShellState
    let dataStore: WKWebsiteDataStore
    let cookieSource: WebKitSessionCookieSource
    let http = URLSessionHTTPClient()

    private(set) var authSession: DesktopAuthSession!
    private(set) var keepAwake: DesktopKeepAwakeController!
    private(set) var quitConfirmation: DesktopQuitConfirmationController!
    private(set) var nativeBackend: NativeHelperProcessClient!
    private(set) var permissionStore: ComputerUsePermissionStore!
    private(set) var computerUseController: ComputerUseRuntimeController!
    private(set) var autoStart: DesktopComputerUseAutoStartSupervisor!
    private(set) var developerTools: DesktopDeveloperToolsController!
    private(set) var automationPrompt: AutomationPermissionPrompt!
    let snapshotStore = ComputerUseSnapshotStore()

    private var tray: DesktopTrayController?
    private var mainWindow: DesktopMainWindowController?
    private var appIsQuitting = false
    private var quitPreparation: Task<Void, Never>? = nil
    private var quitPreparationComplete = false
    private var nativeBackendDisposeTask: Task<Void, Never>? = nil
    private var trayAuthState: DesktopAuthState? = nil
    private var trayAuthLoading = true
    private var trayAuthError: String? = nil
    private let trayAuthRefresh = LatestWinsGuard()

    static func bootstrap() throws -> DesktopAppRuntime {
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let runtimeConfig = try DesktopRuntimeConfig.read(at: resources.appendingPathComponent(DesktopRuntimeConfig.fileName))
        let config = try resolveDesktopConfig(runtimeConfig: runtimeConfig)
        return try DesktopAppRuntime(config: config, resources: resources)
    }

    init(config: DesktopConfig, resources: URL) throws {
        self.config = config
        self.appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        self.userDataDirectory = applicationSupport.appendingPathComponent(config.identity.userDataDirectoryName)
        self.preferences = DesktopPreferencesStore(fileURL: userDataDirectory.appendingPathComponent(DesktopPreferencesStore.fileName))
        self.installationId = try ComputerUseInstallationId.readOrCreate(store: preferences)
        self.assets = DesktopAssetLocator(resources: resources, product: config.identity.product)
        self.clientHeaders = DesktopClientHeaders(clientVersion: appVersion, product: config.identity.product)
        self.shellState = DesktopShellState(
            identity: config.identity, platformUrl: config.platformUrl.absoluteString, environment: config.environment,
            deviceName: SystemInfo.friendlyDeviceName()
        )
        self.dataStore = DesktopWebsiteDataStore.store(for: config.sessionPartition)
        self.cookieSource = WebKitSessionCookieSource(store: dataStore)

        self.keepAwake = DesktopKeepAwakeController(
            store: preferences, blocker: PowerAssertionKeepAwakeBlocker(),
            onChange: { [weak self] in self?.notifyComputerUseChanged() }
        )
        self.quitConfirmation = DesktopQuitConfirmationController(
            confirmQuit: { [weak self] in await self?.confirmQuit() ?? true },
            quit: { NSApp.terminate(nil) }
        )
        self.nativeBackend = NativeHelperProcessClient(
            helperPath: NativeHelperProcessClient.resolveHelperPath(name: "computer-use-helper"),
            onRuntimeError: { error, context in
                NSLog("Native Computer Use helper error: \(error.message) \(context)")
            }
        )
        self.permissionStore = ComputerUsePermissionStore(backend: nativeBackend)
        self.automationPrompt = AutomationPermissionPrompt(
            sourceLabel: config.identity.displayName,
            showDialog: { [weak self] options in await self?.showAutomationDialog(options) ?? 1 },
            openAutomationSettings: { DesktopSystemSettings.open(.automation) },
            onPermissionDenied: { [weak self] target, reason in
                self?.permissionStore.recordAutomationDenied(target, reason: reason)
                self?.notifyComputerUseChanged()
            }
        )
        let apiBaseUrl = config.apiBaseUrl
        self.authSession = DesktopAuthSession(
            apiBaseUrl: apiBaseUrl,
            cookieUrls: [config.webUrl, config.platformUrl],
            cookieSource: cookieSource,
            http: http,
            clientHeaders: clientHeaders,
            tokenUrl: DesktopAuthURLs.tokenUrl(webUrl: config.webUrl),
            consumeUrl: { code, handoffId in DesktopAuthURLs.consumeUrl(webUrl: config.webUrl, code: code, handoffId: handoffId) },
            selectOrgUrl: DesktopAuthURLs.selectOrgUrl(webUrl: config.webUrl, forceSelection: true),
            runAuthWindow: { [weak self] request in try await self?.runAuthWindow(request) },
            onChange: { [weak self] in self?.notifyAuthChanged() },
            onAuthCompleted: { [weak self] in await self?.maybeStartComputerUseAfterAuth() }
        )
        self.developerTools = DesktopDeveloperToolsController(
            fetchFeatureSwitches: { [weak self] in
                guard let self else { return DesktopHTTPResponse(status: 401) }
                return try await self.authSession.fetchWithSessionAuth(URL(string: apiBaseUrl + DesktopDeveloperToolsController.featureSwitchesPath)!)
            },
            setPluginsFeatureEnabled: { _ in },
            setScreenRecordingFeatureEnabled: { _ in },
            onChange: { [weak self] in self?.notifyDeveloperToolsChanged() },
            logRefreshError: { error in NSLog("Unable to refresh desktop developer tools state: \(error)") }
        )
        self.computerUseController = ComputerUseRuntimeController(
            createRuntime: { [unowned self] in self.createHostRuntime() },
            refreshPermissions: { [unowned self] in try await self.permissionStore.refresh() },
            getAuthState: { [unowned self] in try await self.authSession.getAuthState() },
            setHostRuntimeOnline: { _ in },
            onChange: { [weak self] in self?.notifyComputerUseChanged() }
        )
        self.autoStart = DesktopComputerUseAutoStartSupervisor(
            getState: { [unowned self] in self.computerUseState() },
            start: { [unowned self] in try await self.computerUseController.start() },
            logError: { error in NSLog("Desktop Computer Use auto-start failed: \(error)") }
        )
    }

    // MARK: Lifecycle

    func terminateBecauseAnotherInstanceIsRunning() -> Bool {
        guard let bundleId = Bundle.main.bundleIdentifier else { return false }
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter {
            $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }
        guard let other = others.first else { return false }
        other.activate()
        return true
    }

    func start(launchArguments: [String]) {
        NSApp.applicationIconImage = assets.appIcon()
        do {
            try keepAwake.load()
        } catch {
            NSLog("Desktop keep-awake preference failed to load: \(error)")
        }
        shellState.keepAwake = keepAwake.state
        installApplicationMenu()
        installTray()

        if ProcessInfo.processInfo.environment["OKOU_DESKTOP_SMOKE_TEST"] == "1" {
            runSmokeTest()
            return
        }

        refreshPermissionsForState()
        developerTools.requestRefresh()
        refreshTrayAuth()

        let pendingCallback = DesktopAuthURLs.parseCallback(argv: launchArguments, authScheme: config.identity.authScheme)
        if pendingCallback != nil {
            authStartGate.suppressRetry()
        }
        let launch = DesktopLaunchComputerUse(
            pendingCallback: pendingCallback,
            consumeAuthCallback: { [unowned self] callback in
                try await self.authSession.consumeCode(callback.code, handoffId: callback.handoffId)
            },
            isComputerUseSetupRequired: { [unowned self] in try await self.shouldOpenSetupWindowOnLaunch() },
            openSetupWindow: { [unowned self] in self.showMainWindow() },
            requestAutoStartComputerUse: { [unowned self] in self.autoStart.requestStart() },
            logAuthError: { error in NSLog("Desktop auth flow failed: \(error)") },
            logLaunchError: { error in NSLog("Desktop Computer Use launch setup check failed: \(error)") }
        )
        Task { await launch.start() }
    }

    private func runSmokeTest() {
        // Mirrors `desktop-smoke-test.ts`: prove the shell reached the ready
        // state, then exit so packaging CI can assert on the output.
        authSession.signOut()
        _ = DesktopTrayMenu.buildItems(trayMenuState(), actions: trayActions())
        let window = ensureMainWindow()
        _ = window.window.contentView
        FileHandle.standardOutput.write(Data("[smoke-test] desktop main ready\n".utf8))
        exit(0)
    }

    private func shouldOpenSetupWindowOnLaunch() async throws -> Bool {
        let permissions = try await permissionStore.refresh()
        notifyComputerUseChanged()
        if !permissions.hasRequired {
            return true
        }
        let authState = try await authSession.getAuthState()
        return isComputerUseSetupRequired(authState: authState, permissions: permissions)
    }

    func handleOpenURL(_ rawUrl: String) {
        if let callback = DesktopAuthURLs.parseCallback(rawUrl, authScheme: config.identity.authScheme) {
            dispatchAuthCallback(callback)
            return
        }
        NSLog("Ignoring unexpected URL open request: \(rawUrl)")
    }

    private func dispatchAuthCallback(_ callback: DesktopAuthCallback) {
        authStartGate.suppressRetry()
        authSession.consumeCallback(callback) { error in
            NSLog("Desktop auth flow failed: \(error)")
        }
    }

    // MARK: Auth

    private func runAuthWindow(_ request: DesktopAuthWindowRequest) async throws {
        try await DesktopAuthWebWindow.run(
            config: config, request: request, dataStore: dataStore,
            onCompleteSignIn: { [weak self] token in self?.authSession.completeSignIn(token: token) },
            openExternal: { [weak self] url in self?.openExternal(url) }
        )
    }

    func openSignIn() {
        guard authStartGate.shouldOpen() else { return }
        openExternal(DesktopAuthURLs.startUrl(webUrl: config.webUrl, authScheme: config.identity.authScheme))
    }

    func openExternal(_ rawUrl: String) {
        if let url = URL(string: rawUrl) {
            NSWorkspace.shared.open(url)
        }
    }

    func selectOrganization() async {
        do {
            try await authSession.selectOrganization()
        } catch {
            NSLog("Desktop workspace selection failed: \(error)")
            shellState.lastActionError = String(describing: error)
        }
    }

    func signOut() async {
        await DesktopWebsiteDataStore.clearSignOutStorage(dataStore)
        authSession.signOut()
        await computerUseController.stopForAuthChange()
    }

    private func maybeStartComputerUseAfterAuth() async {
        await computerUseController.stopForAuthChange()
        notifyAuthChanged()
        do {
            let permissions = try await permissionStore.refresh()
            notifyComputerUseChanged()
            if permissions.hasRequired {
                try await computerUseController.start(userInitiated: true)
            }
        } catch {
            NSLog("Desktop Computer Use start after sign-in failed: \(error)")
        }
    }

    private func notifyAuthChanged() {
        shellState.signingIn = authSession.isSigningIn
        refreshTrayAuth()
        developerTools.requestRefresh()
    }

    /// Fetches the auth state once for the tray and the shell; stale results
    /// are dropped when a newer refresh is in flight.
    func refreshTrayAuth() {
        let token = trayAuthRefresh.next()
        trayAuthLoading = true
        shellState.authLoading = true
        tray?.refresh()
        Task { @MainActor in
            do {
                let state = try await authSession.getAuthState()
                guard token.isCurrent else { return }
                trayAuthState = state
                trayAuthError = nil
                shellState.auth = state
                shellState.authError = nil
            } catch {
                guard token.isCurrent else { return }
                trayAuthState = nil
                trayAuthError = String(describing: error)
                shellState.auth = nil
                shellState.authError = trayAuthError
            }
            trayAuthLoading = false
            shellState.authLoading = false
            shellState.signingIn = authSession.isSigningIn
            tray?.refresh()
        }
    }

    // MARK: Computer Use

    private func createHostRuntime() -> ComputerUseRuntimeLike {
        let sessionFetch = ComputerUseSessionFetch(
            platformUrl: config.platformUrl, cookieSource: cookieSource, http: http, clientHeaders: clientHeaders,
            getCachedAuthToken: { [weak self] in await self?.cachedAuthToken() },
            getAuthToken: { [weak self] force in try await self?.authToken(forceRefresh: force) }
        )
        let executor = ComputerUseCommandExecutor(backend: nativeBackend, snapshotStore: snapshotStore)
        let http = self.http
        return ComputerUseHostRuntime(options: ComputerUseHostRuntime.Options(
            platformUrl: config.platformUrl,
            installationId: installationId,
            hostName: SystemInfo.systemHostName(fallback: config.identity.displayName),
            appVersion: appVersion,
            sessionFetch: sessionFetch.fetch,
            hostFetch: { request in try await http.send(request) },
            clientHeaders: clientHeaders,
            getPermissions: { [unowned self] in try await self.permissionStore.refresh() },
            getSupportedCapabilities: { ComputerUseCapabilities.supported },
            executeCommand: { command, permissions in await executor.execute(command, permissions: permissions) },
            onCommandFailure: { [weak self] command, failure in self?.automationPrompt.handle(command: command, failure: failure) },
            onChange: { [weak self] in self?.notifyComputerUseChanged() }
        ))
    }

    private func cachedAuthToken() async -> String? {
        authSession.cachedToken
    }

    private func authToken(forceRefresh: Bool) async throws -> String? {
        try await authSession.getToken(forceRefresh: forceRefresh)
    }

    func computerUseState() -> DesktopComputerUseState {
        DesktopComputerUseState(
            platform: "darwin", supported: true, deviceName: shellState.deviceName, permissions: permissionStore.state,
            host: computerUseController.hostState, keepAwake: keepAwake.state, plugins: nil
        )
    }

    func notifyComputerUseChanged() {
        shellState.permissions = permissionStore.state
        shellState.host = computerUseController.hostState
        shellState.keepAwake = keepAwake.state
        tray?.refresh()
        autoStart.restartRecoverableRuntimeState()
    }

    private func notifyDeveloperToolsChanged() {
        shellState.developerTools = developerTools.state
        installApplicationMenu()
    }

    private func refreshPermissionsForState() {
        Task { @MainActor in
            do {
                try await permissionStore.refresh()
            } catch {
                NSLog("Unable to refresh native Computer Use permissions: \(error)")
            }
            notifyComputerUseChanged()
        }
    }

    func startComputerUse(userInitiated: Bool) async {
        do {
            try await computerUseController.start(userInitiated: userInitiated)
        } catch {
            shellState.lastActionError = String(describing: error)
            NSLog("Desktop Computer Use start failed: \(error)")
        }
        notifyComputerUseChanged()
    }

    func stopComputerUse() async {
        await computerUseController.stop()
        notifyComputerUseChanged()
    }

    func refreshComputerUsePermissions() async {
        do {
            let permissions = try await permissionStore.refresh()
            if !permissions.hasRequired {
                computerUseController.clearBlockedHostState()
            }
        } catch {
            NSLog("Unable to refresh native Computer Use permissions: \(error)")
        }
        notifyComputerUseChanged()
    }

    func requestAccessibilityPermission() async {
        do {
            try await permissionStore.requestAccessibility()
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    func requestScreenRecordingPermission() async {
        do {
            try await permissionStore.requestScreenRecording()
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    func probeAutomationPermission(_ target: ComputerUseAutomationPermissionTarget) async {
        do {
            try await permissionStore.probeAutomation(target)
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    func setKeepAwakeEnabled(_ enabled: Bool) {
        do {
            try keepAwake.setEnabled(enabled)
        } catch {
            NSLog("Desktop keep-awake preference failed to save: \(error)")
        }
        notifyComputerUseChanged()
    }

    func setDeveloperToolsEnabled(_ enabled: Bool) {
        _ = developerTools.setEnabled(enabled)
        notifyDeveloperToolsChanged()
    }

    private func showAutomationDialog(_ options: AutomationPermissionDialogOptions) async -> Int {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = options.message
        alert.informativeText = options.detail
        for title in options.buttons {
            alert.addButton(withTitle: title)
        }
        if let window = mainWindow?.window, window.isVisible {
            return Self.buttonIndex(await alert.beginSheetModal(for: window))
        }
        NSApp.activate()
        return Self.buttonIndex(alert.runModal())
    }

    // MARK: Quit

    func applicationShouldTerminate() -> NSApplication.TerminateReply {
        if !quitConfirmation.isQuitAllowed {
            Task { await self.quitConfirmation.requestQuit() }
            return .terminateCancel
        }
        appIsQuitting = true
        keepAwake.release()
        if quitPreparationComplete {
            return .terminateNow
        }
        if quitPreparation == nil {
            quitPreparation = Task { @MainActor in
                await self.computerUseController.stopForQuit()
                await self.disposeNativeBackend(reason: .appQuit)
                self.quitPreparationComplete = true
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func requestQuit() {
        Task { await self.quitConfirmation.requestQuit() }
    }

    /// Shared by app quit and update relaunch; the helper is disposed once.
    func disposeNativeBackend(reason: ComputerUseNativeShutdownReason) async {
        if nativeBackendDisposeTask == nil {
            let backend = nativeBackend!
            nativeBackendDisposeTask = Task { await backend.dispose(reason: reason) }
        }
        await nativeBackendDisposeTask?.value
    }

    private func confirmQuit() async -> Bool {
        let options = DesktopQuitConfirmationOptions.build(displayName: config.identity.displayName)
        let alert = NSAlert()
        alert.messageText = options.message
        alert.informativeText = options.detail
        alert.alertStyle = .informational
        for title in options.buttons {
            alert.addButton(withTitle: title)
        }
        if let window = mainWindow?.window, window.isVisible {
            let response = await alert.beginSheetModal(for: window)
            return DesktopQuitConfirmationOptions.isConfirmed(response: Self.buttonIndex(response))
        }
        NSApp.activate()
        return DesktopQuitConfirmationOptions.isConfirmed(response: Self.buttonIndex(alert.runModal()))
    }

    /// `NSAlert` numbers its buttons from `alertFirstButtonReturn`.
    private static func buttonIndex(_ response: NSApplication.ModalResponse) -> Int {
        Int(response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue)
    }

    // MARK: Windows

    @discardableResult
    private func ensureMainWindow() -> DesktopMainWindowController {
        if let mainWindow {
            return mainWindow
        }
        let controller = DesktopMainWindowController(runtime: self)
        mainWindow = controller
        return controller
    }

    func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        ensureMainWindow().showAndFocus()
    }

    func mainWindowDidHide() {
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: Menus

    private func installApplicationMenu() {
        let displayName = config.identity.displayName
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: displayName)
        appMenu.addItem(withTitle: "About \(displayName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let updates = appMenu.addItem(withTitle: "Check for Updates...", action: nil, keyEquivalent: "")
        updates.isEnabled = false
        appMenu.addItem(.separator())
        let developerToolsState = developerTools?.state ?? DesktopDeveloperToolsState(available: false, enabled: false)
        if developerToolsState.available {
            let item = ClosureMenuItem(title: "Developer Tools") { [weak self] in
                self?.setDeveloperToolsEnabled(!developerToolsState.enabled)
            }
            item.state = developerToolsState.enabled ? .on : .off
            appMenu.addItem(item)
            appMenu.addItem(.separator())
        }
        appMenu.addItem(ClosureMenuItem(title: "Quit \(displayName)", keyEquivalent: "q") { [weak self] in self?.requestQuit() })
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = mainMenu
    }

    private func installTray() {
        let tray = DesktopTrayController(
            displayName: config.identity.displayName,
            assets: assets,
            getComputerUseState: { [unowned self] in self.computerUseState() },
            buildMenuItems: { [unowned self] in DesktopTrayMenu.buildItems(self.trayMenuState(), actions: self.trayActions()) }
        )
        tray.install()
        self.tray = tray
    }

    private func trayMenuState() -> DesktopTrayMenuState {
        DesktopTrayMenuState(
            brandName: config.identity.brandName, computerUse: computerUseState(), auth: trayAuthState,
            authLoading: trayAuthLoading, authError: trayAuthError, recorder: nil
        )
    }

    /// Wraps a tray action so failures are logged and the menu refreshes.
    private func trayAction(_ label: String, refreshAuth: Bool = false, _ action: @escaping () async -> Void) -> () -> Void {
        { [weak self] in
            Task { @MainActor in
                await action()
                if refreshAuth {
                    self?.refreshTrayAuth()
                } else {
                    self?.tray?.refresh()
                }
            }
        }
    }

    private func trayActions() -> DesktopTrayMenuActions {
        DesktopTrayMenuActions(
            showMainWindow: trayAction("show main window") { [weak self] in self?.showMainWindow() },
            startComputerUse: trayAction("start Computer Use") { [weak self] in await self?.startComputerUse(userInitiated: true) },
            stopComputerUse: trayAction("stop Computer Use") { [weak self] in await self?.stopComputerUse() },
            refreshStatus: trayAction("refresh status", refreshAuth: true) { [weak self] in await self?.refreshComputerUsePermissions() },
            openSignIn: trayAction("open sign in", refreshAuth: true) { [weak self] in self?.openSignIn() },
            switchWorkspace: trayAction("switch workspace", refreshAuth: true) { [weak self] in await self?.selectOrganization() },
            signOut: trayAction("sign out", refreshAuth: true) { [weak self] in await self?.signOut() },
            requestAccessibilityPermission: trayAction("request Accessibility permission") { [weak self] in await self?.requestAccessibilityPermission() },
            requestScreenRecordingPermission: trayAction("request Screen Recording permission") { [weak self] in await self?.requestScreenRecordingPermission() },
            openAccessibilitySettings: { DesktopSystemSettings.open(.accessibility) },
            openScreenRecordingSettings: { DesktopSystemSettings.open(.screenRecording) },
            setKeepAwakeEnabled: { [weak self] enabled in self?.setKeepAwakeEnabled(enabled) },
            startScreenRecording: {},
            stopScreenRecording: {},
            retryScreenRecordingDelivery: {},
            quit: { [weak self] in self?.requestQuit() }
        )
    }
}

enum DesktopDegradedMode {
    static func report(error: Error) {
        NSLog("Desktop main module failed to load: \(error)")
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Startup Error"
        alert.informativeText = "\(ProcessInfo.processInfo.processName) hit an error during startup.\n\n\(error)"
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

/// Locates packaged brand assets under `Contents/Resources/assets`.
struct DesktopAssetLocator {
    let resources: URL
    let brand: DesktopBrandAssets

    init(resources: URL, product: DesktopProduct) {
        self.resources = resources
        self.brand = DesktopBrandAssets.assets(for: product)
    }

    func assetURL(_ fileName: String) -> URL {
        resources.appendingPathComponent("assets").appendingPathComponent(fileName)
    }

    func appIcon() -> NSImage? {
        NSImage(contentsOf: assetURL(brand.appIconFileName))
    }

    func trayIcon(frame: DesktopTrayIconFrame) -> NSImage? {
        let fileName: String
        switch frame {
        case .disabled: fileName = brand.trayIconDisabledFileName
        case .online: fileName = brand.trayIconFileName
        case .running: fileName = brand.trayIconRunningFileName
        }
        let image = NSImage(contentsOf: assetURL(fileName))
        image?.size = NSSize(width: 18, height: 18)
        return image
    }
}

enum DesktopSystemSettings {
    enum Pane: String {
        case accessibility = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case screenRecording = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case automation = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    }

    static func open(_ pane: Pane) {
        if let url = URL(string: pane.rawValue) {
            NSWorkspace.shared.open(url)
        }
    }
}
#endif
