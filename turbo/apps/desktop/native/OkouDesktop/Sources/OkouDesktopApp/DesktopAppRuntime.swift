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
    private(set) var screenRecorder: DesktopRecorderController!
    private(set) var filesystemPlugin: DesktopFilesystemPluginManager!
    private(set) var mcpPlugin: DesktopMcpPluginManager!
    let snapshotStore = ComputerUseSnapshotStore()
    let recorderUIState = RecorderUIState()
    private var recorderWindows: DesktopRecorderWindows? = nil
    private var pendingAreaAudio: DesktopRecorderAudioChoice? = nil
    private var recordingPollTimer: Timer? = nil
    private var stopRecordingHotKey: GlobalHotKey? = nil
    private var lastLoggedRecorderError: DesktopRecorderError? = nil
    private var deliverabilityCheck: (at: Double, task: Task<Bool, Error>)? = nil
    static let deliverabilityCheckLifetimeMs: Double = 5 * 60 * 1000
    static let screenRecordingPollIntervalSeconds: Double = 1

    private var tray: DesktopTrayController?
    private var mainWindow: DesktopMainWindowController?
    private var appIsQuitting = false
    private var quitPreparation: Task<Void, Never>? = nil
    private var quitPreparationComplete = false
    private var nativeBackendDisposeTask: Task<Void, Never>? = nil
    private var updater: DesktopUpdater? = nil
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
            quit: { [weak self] in self?.quitAfterPreparation() }
        )
        SentrySetup.start(resources: resources, version: appVersion)
        self.nativeBackend = NativeHelperProcessClient(
            helperPath: NativeHelperProcessClient.resolveHelperPath(name: "computer-use-helper"),
            onRuntimeError: { error, context in
                NSLog("Native Computer Use helper error: \(error.message) \(context)")
                SentrySetup.captureNativeHelperError(error, context: context)
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
            setPluginsFeatureEnabled: { [weak self] enabled in
                self?.filesystemPlugin.setFeatureEnabled(enabled)
                self?.mcpPlugin.setFeatureEnabled(enabled)
            },
            setScreenRecordingFeatureEnabled: { [weak self] enabled in self?.screenRecorder.setFeatureEnabled(enabled) },
            onChange: { [weak self] in self?.notifyDeveloperToolsChanged() },
            logRefreshError: { error in NSLog("Unable to refresh desktop developer tools state: \(error)") }
        )
        self.filesystemPlugin = DesktopFilesystemPluginManager(store: preferences, onChange: { [weak self] in self?.notifyComputerUseChanged() })
        filesystemPlugin.load()
        self.mcpPlugin = DesktopMcpPluginManager(store: preferences, onChange: { [weak self] in self?.notifyComputerUseChanged() })
        mcpPlugin.load()
        let recordingsDirectory = userDataDirectory.appendingPathComponent("recordings")
        self.screenRecorder = DesktopRecorderController(
            createBackend: {
                RecorderHelperProcessClient(helperPath: NativeHelperProcessClient.resolveHelperPath(name: "screen-recorder-helper"))
            },
            createOutputPath: {
                recordingsDirectory.appendingPathComponent("screen-recording-\(Int64(Date().timeIntervalSince1970 * 1000)).mp4").path
            },
            canDeliver: { [unowned self] in try await self.checkDeliverability() },
            deliver: { [unowned self] recording in try await self.deliverRecording(recording) },
            openReview: { [weak self] url in self?.openExternal(url) },
            onChange: { [weak self] in self?.notifyScreenRecorderChanged() },
            logError: { error in NSLog("Desktop screen recording teardown failed: \(error)") }
        )
        self.computerUseController = ComputerUseRuntimeController(
            createRuntime: { [unowned self] in self.createHostRuntime() },
            refreshPermissions: { [unowned self] in try await self.permissionStore.refresh() },
            getAuthState: { [unowned self] in try await self.authSession.getAuthState() },
            setHostRuntimeOnline: { [weak self] online in
                self?.filesystemPlugin.setHostRuntimeOnline(online)
                self?.mcpPlugin.setHostRuntimeOnline(online)
            },
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

        updater = DesktopUpdater.install(
            config: config, appVersion: appVersion, http: http,
            getComputerUseHostState: { [unowned self] in self.computerUseController.hostState },
            prepareForQuitAndInstall: { [unowned self] in await self.prepareForQuitAndInstall() }
        )
        installApplicationMenu()

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
            getSupportedCapabilities: { [unowned self] in
                ComputerUseCapabilities.supported + self.filesystemPlugin.capabilities + self.mcpPlugin.capabilities
            },
            executeCommand: { [unowned self] command, permissions in
                if command.kind == ComputerUseCapabilities.pluginCallKind {
                    if DesktopMcpPluginManager.isMcpCallPayload(command.payload) {
                        return await self.mcpPlugin.execute(command)
                    }
                    return await self.filesystemPlugin.execute(command)
                }
                return await executor.execute(command, permissions: permissions)
            },
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
            host: computerUseController.hostState, keepAwake: keepAwake.state,
            plugins: DesktopComputerUsePluginsState(filesystem: filesystemPlugin.state, mcp: mcpPlugin.state)
        )
    }

    func notifyComputerUseChanged() {
        filesystemPlugin.setHostRuntimeOnline(computerUseController.isRuntimeOnline)
        mcpPlugin.setHostRuntimeOnline(computerUseController.isRuntimeOnline)
        shellState.plugins = DesktopComputerUsePluginsState(filesystem: filesystemPlugin.state, mcp: mcpPlugin.state)
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

    func setFilesystemPluginEnabled(_ enabled: Bool) {
        do {
            try filesystemPlugin.setEnabled(enabled)
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    /// The Electron app asks with an open-directory dialog that can also
    /// create folders.
    func addFilesystemPluginAllowedDirectory() async {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        let response: NSApplication.ModalResponse
        if let window = mainWindow?.window, window.isVisible {
            response = await panel.beginSheetModal(for: window)
        } else {
            NSApp.activate()
            response = panel.runModal()
        }
        guard response == .OK, let directory = panel.url?.path else { return }
        do {
            try filesystemPlugin.addAllowedDirectory(directory)
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    func removeFilesystemPluginAllowedDirectory(_ directory: String) {
        do {
            try filesystemPlugin.removeAllowedDirectory(directory)
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    /// Returns the parse error to show inline, or nil on success.
    func importMcpPluginServers(_ json: String) -> String? {
        guard !json.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "MCP server configuration must be a JSON string"
        }
        do {
            try mcpPlugin.importServersJson(json)
        } catch {
            return String(describing: error)
        }
        notifyComputerUseChanged()
        return nil
    }

    func setMcpPluginServerEnabled(_ server: String, _ enabled: Bool) {
        do {
            try mcpPlugin.setServerEnabled(server, enabled)
        } catch {
            shellState.lastActionError = String(describing: error)
        }
        notifyComputerUseChanged()
    }

    func removeMcpPluginServer(_ server: String) {
        do {
            try mcpPlugin.removeServer(server)
        } catch {
            shellState.lastActionError = String(describing: error)
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
        if quitPreparationComplete {
            appIsQuitting = true
            keepAwake.release()
            return .terminateNow
        }
        // Only reached when something other than `quitAfterPreparation` asks
        // AppKit to terminate while Computer Use is still shutting down (for
        // example a logout). Those requests arrive from the run loop, so the
        // reply task below can run inside AppKit's wait.
        Task { @MainActor in
            await self.prepareForQuit(reason: .appQuit)
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func requestQuit() {
        Task { await self.quitConfirmation.requestQuit() }
    }

    /// Runs once the user confirmed the quit: stop Computer Use first so the
    /// delegate can answer `.terminateNow`, then terminate from the run loop.
    private func quitAfterPreparation() {
        Task { @MainActor in
            await self.prepareForQuit(reason: .appQuit)
            Self.terminateFromRunLoop()
        }
    }

    /// Port of the Electron `before-quit` preparation: stop the host, dispose
    /// the helper once, and remember that the app may now exit.
    private func prepareForQuit(reason: ComputerUseNativeShutdownReason) async {
        appIsQuitting = true
        keepAwake.release()
        if quitPreparation == nil {
            quitPreparation = Task { @MainActor in
                self.mcpPlugin.stop()
                await self.computerUseController.stopForQuit()
                await self.disposeNativeBackend(reason: reason)
                self.quitPreparationComplete = true
            }
        }
        await quitPreparation?.value
    }

    /// Update restarts never prompt: allow the quit, stop the host and release
    /// the helper before the installer swaps the bundle.
    func prepareForQuitAndInstall() async {
        quitConfirmation.allowQuitWithoutConfirmation()
        await prepareForQuit(reason: .updateRelaunch)
    }

    /// Asks AppKit to terminate from a run-loop callback instead of from the
    /// Swift concurrency job that decided to quit. `terminate(_:)` spins a
    /// nested event loop while the delegate answers `.terminateLater`, and
    /// that nested loop does not drain the main dispatch queue when the call
    /// started inside a main-actor task, so the task that would deliver
    /// `reply(toApplicationShouldTerminate:)` never runs and the app hangs
    /// with its menus still responding. Seen on a real Mac before this fix.
    nonisolated static func terminateFromRunLoop() {
        RunLoop.main.perform(inModes: [.common]) {
            MainActor.assumeIsolated {
                NSApp.terminate(nil)
            }
        }
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
        if let mainWindow, mainWindow.window.isVisible {
            // The tray can be used while another app covers the main window;
            // bring it forward so the sheet is not attached behind that app.
            mainWindow.showAndFocus()
            let response = await alert.beginSheetModal(for: mainWindow.window)
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
        let updates = ClosureMenuItem(title: "Check for Updates...") { [weak self] in
            guard let updater = self?.updater else { return }
            Task { await updater.check(interactive: true) }
        }
        updates.isEnabled = updater != nil
        appMenu.addItem(updates)
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
            authLoading: trayAuthLoading, authError: trayAuthError, recorder: screenRecorder.state
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
            startScreenRecording: trayAction("start screen recording") { [weak self] in self?.startScreenRecordingFromTray() },
            stopScreenRecording: trayAction("stop screen recording") { [weak self] in await self?.stopScreenRecording() },
            retryScreenRecordingDelivery: trayAction("retry screen recording delivery") { [weak self] in await self?.retryScreenRecordingDelivery() },
            quit: { [weak self] in self?.requestQuit() }
        )
    }
}

// MARK: - Screen recorder

extension DesktopAppRuntime: RecorderWindowBridge {
    var uiState: RecorderUIState { recorderUIState }

    private func windows() -> DesktopRecorderWindows {
        if let recorderWindows { return recorderWindows }
        let created = DesktopRecorderWindows(bridge: self)
        recorderWindows = created
        return created
    }

    /// Whether a finished recording could be handed back, memoized for five
    /// minutes so Start does not pay for two API round trips.
    private func checkDeliverability() async throws -> Bool {
        let now = Date().timeIntervalSince1970 * 1000
        if let check = deliverabilityCheck, now - check.at < Self.deliverabilityCheckLifetimeMs {
            return try await check.task.value
        }
        let task = Task<Bool, Error> { @MainActor in
            let auth = try await self.authSession.getAuthState()
            return auth.isReady
        }
        deliverabilityCheck = (now, task)
        do {
            return try await task.value
        } catch {
            if deliverabilityCheck?.task == task {
                deliverabilityCheck = nil
            }
            throw error
        }
    }

    private func deliverRecording(_ recording: DesktopRecorderRecording) async throws -> DeliveredRecording {
        let auth = try await authSession.getAuthState()
        guard let user = auth.user else {
            throw DesktopRecorderDeliveryError("Sign in to Okou to upload the recording")
        }
        let http = self.http
        let delivery = RecorderDelivery(
            apiBaseUrl: config.apiBaseUrl,
            appUrl: config.platformUrl.absoluteString,
            userId: user.userId,
            fetchWithSessionAuth: { [unowned self] url, method, headers, body in
                try await self.authSession.fetchWithSessionAuth(url, method: method, headers: headers, body: body)
            },
            fetchUpload: { request in try await http.send(request) }
        )
        return try await delivery.deliver(recording)
    }

    func startScreenRecordingFromTray() {
        windows().showBar()
        Task { _ = try? await self.checkDeliverability() }
    }

    func stopScreenRecording() async {
        do {
            try await screenRecorder.stop()
        } catch {
            NSLog("Desktop screen recording stop failed: \(error)")
        }
    }

    func retryScreenRecordingDelivery() async {
        do {
            try await screenRecorder.retryDelivery()
        } catch {
            NSLog("Desktop screen recording retry failed: \(error)")
        }
    }

    private func notifyScreenRecorderChanged() {
        let state = screenRecorder.state
        recorderUIState.state = state
        tray?.refresh()
        if let error = state.error, error != lastLoggedRecorderError {
            NSLog("Desktop screen recording \(error.code.rawValue): \(error.message)")
        }
        lastLoggedRecorderError = state.error
        let isCapturing = state.status == .recording || state.status == .paused
        let showsController = isCapturing || state.status == .finalizing || state.status == .delivering
        if !showsController {
            recorderWindows?.hideController()
        }
        if isCapturing == (recordingPollTimer != nil) {
            return
        }
        if isCapturing {
            recordingPollTimer = Timer.scheduledTimer(withTimeInterval: Self.screenRecordingPollIntervalSeconds, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    do {
                        try await self?.screenRecorder.refreshRecordingStatus()
                    } catch {
                        NSLog("Desktop screen recording status refresh failed: \(error)")
                    }
                }
            }
            stopRecordingHotKey = GlobalHotKey.stopRecording { [weak self] in
                Task { @MainActor in await self?.stopScreenRecording() }
            }
            if stopRecordingHotKey == nil {
                NSLog("Unable to register the screen recording stop shortcut")
            }
            return
        }
        recordingPollTimer?.invalidate()
        recordingPollTimer = nil
        stopRecordingHotKey?.unregister()
        stopRecordingHotKey = nil
    }

    private func startRecorderCapture(_ request: DesktopRecorderPrepareRequest, captured: DesktopRecorderArea?) async throws {
        let windows = self.windows()
        let startedAt = Date()
        try await screenRecorder.ensureScreenRecordingPermission()
        try await screenRecorder.prepare(request)
        try await screenRecorder.start()
        windows.hideBar()
        windows.showController(captured: captured)
        NSLog("Desktop screen recording started in %d ms", Int(Date().timeIntervalSince(startedAt) * 1000))
    }

    func getCapabilities() async throws -> DesktopRecorderCapabilities {
        try await screenRecorder.getCapabilities()
    }

    func startCapture(_ request: DesktopRecorderCaptureRequest) async throws {
        let windows = self.windows()
        let sourceId: String
        let kind: DesktopRecorderCaptureKind
        switch request.target {
        case .display:
            sourceId = windows.displaySourceId(windows.barDisplayId())
            kind = .display
        case let .window(id):
            sourceId = id
            kind = .window
        }
        try await startRecorderCapture(
            DesktopRecorderPrepareRequest(sourceId: sourceId, sourceKind: kind, systemAudio: request.audio.systemAudio, microphone: request.audio.microphone, area: nil),
            captured: nil
        )
    }

    func beginAreaSelection(_ audio: DesktopRecorderAudioChoice) {
        pendingAreaAudio = audio
        windows().openAreaSelectors()
    }

    func completeAreaSelection(_ selection: DesktopRecorderAreaSelection?) {
        let windows = self.windows()
        let audio = pendingAreaAudio
        pendingAreaAudio = nil
        windows.closeAreaSelectors()
        guard let selection, let audio else { return }
        guard let display = windows.displayBounds(selection.displayId) else {
            NSLog("The screen that region was drawn on is gone")
            return
        }
        let area = RecorderOverlayGeometry.areaToGlobal(selection.area, display: display)
        Task { @MainActor in
            do {
                try await self.startRecorderCapture(
                    DesktopRecorderPrepareRequest(
                        sourceId: windows.displaySourceId(selection.displayId), sourceKind: .area,
                        systemAudio: audio.systemAudio, microphone: audio.microphone, area: area
                    ),
                    captured: area
                )
            } catch {
                NSLog("Desktop screen recording start failed: \(error)")
                windows.showBar()
            }
        }
    }

    func selectWindow() async -> DesktopRecorderWindowChoice? {
        await windows().selectWindow()
    }

    func listWindowOptions() async throws -> [DesktopRecorderWindowOption] {
        try await screenRecorder.ensureScreenRecordingPermission()
        async let sources = screenRecorder.listSources()
        async let previews = screenRecorder.listWindowPreviews()
        return RecorderWindowOptions.build(sources: try await sources, previews: try await previews)
    }

    func completeWindowSelection(_ choice: DesktopRecorderWindowChoice?) {
        windows().completeWindowSelection(choice)
    }

    func pause() async throws {
        try await screenRecorder.pause()
    }

    func resume() async throws {
        try await screenRecorder.resume()
    }

    func discard() async throws {
        try await screenRecorder.discard()
    }

    func stop() async throws {
        try await screenRecorder.stop()
    }

    func cancel() {
        windows().hideBar()
    }

    func openScreenRecordingSettings() {
        DesktopSystemSettings.open(.screenRecording)
    }
}

/// Port of `bootstrap-degraded.ts`: when the runtime cannot start, keep the
/// auto-updater alive so a fixed build can still arrive, log the failure, and
/// show the startup dialog. Exits when updates cannot be installed.
@MainActor
final class DesktopDegradedMode {
    private var updater: DesktopUpdater? = nil

    static func enter(error: Error) -> DesktopDegradedMode? {
        NSLog("Desktop main module failed to load: \(error)")
        let mode = DesktopDegradedMode()
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
        var displayName = ProcessInfo.processInfo.processName
        if let runtimeConfig = try? DesktopRuntimeConfig.read(at: resources.appendingPathComponent(DesktopRuntimeConfig.fileName)),
            let config = try? resolveDesktopConfig(runtimeConfig: runtimeConfig)
        {
            displayName = config.identity.displayName
            SentrySetup.start(resources: resources, version: version)
            SentrySDKBridge.captureStartupFailure(error)
            mode.updater = DesktopUpdater.install(
                config: config, appVersion: version, http: URLSessionHTTPClient(),
                getComputerUseHostState: { .offline },
                prepareForQuitAndInstall: {}
            )
        }
        mode.writeFailureLog(error)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "\(displayName) hit an error during startup."
        alert.informativeText = mode.updater != nil
            ? "Keep the app running: a fixed update will be downloaded and installed automatically as soon as it is available."
            : "Please reinstall the latest version of \(displayName)."
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
        if mode.updater == nil {
            NSApp.terminate(nil)
            return nil
        }
        return mode
    }

    private func writeFailureLog(_ error: Error) {
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Logs").appendingPathComponent(Bundle.main.bundleIdentifier ?? "okou-desktop")
        guard let logs else { return }
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let line = "\(ISOTimestamp.now()) \(error)\n"
        let file = logs.appendingPathComponent("desktop-bootstrap-failure.log")
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
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
