#if canImport(AppKit)
import AppKit
import OkouDesktopKit

/// The Swift counterpart of `main.ts`: owns configuration, preferences, the
/// tray, the main window, keep-awake and quit handling.
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
    private(set) var keepAwake: DesktopKeepAwakeController!
    private(set) var quitConfirmation: DesktopQuitConfirmationController!
    private var tray: DesktopTrayController?
    private var mainWindow: DesktopMainWindowController?
    private var appIsQuitting = false

    static func bootstrap() throws -> DesktopAppRuntime {
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let runtimeConfig = try DesktopRuntimeConfig.read(
            at: resources.appendingPathComponent(DesktopRuntimeConfig.fileName)
        )
        let config = try resolveDesktopConfig(runtimeConfig: runtimeConfig)
        return try DesktopAppRuntime(config: config, resources: resources)
    }

    init(config: DesktopConfig, resources: URL) throws {
        self.config = config
        self.appVersion =
            (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        self.userDataDirectory = applicationSupport.appendingPathComponent(config.identity.userDataDirectoryName)
        self.preferences = DesktopPreferencesStore(
            fileURL: userDataDirectory.appendingPathComponent(DesktopPreferencesStore.fileName)
        )
        self.installationId = try ComputerUseInstallationId.readOrCreate(store: preferences)
        self.assets = DesktopAssetLocator(resources: resources, product: config.identity.product)
        self.clientHeaders = DesktopClientHeaders(clientVersion: appVersion, product: config.identity.product)
        self.shellState = DesktopShellState(
            identity: config.identity,
            platformUrl: config.platformUrl.absoluteString,
            environment: config.environment,
            deviceName: DesktopAppRuntime.deviceName()
        )
        self.keepAwake = DesktopKeepAwakeController(
            store: preferences,
            blocker: PowerAssertionKeepAwakeBlocker(),
            onChange: { [weak self] in self?.notifyComputerUseChanged() }
        )
        self.quitConfirmation = DesktopQuitConfirmationController(
            confirmQuit: { [weak self] in await self?.confirmQuit() ?? true },
            quit: { [weak self] in
                self?.appIsQuitting = true
                NSApp.terminate(nil)
            }
        )
    }

    static func deviceName() -> String? {
        let hostname = ProcessInfo.processInfo.hostName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hostname.isEmpty else { return nil }
        if hostname.lowercased().hasSuffix(".local") {
            return String(hostname.dropLast(".local".count))
        }
        return hostname
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

        if let callback = DesktopAuthURLs.parseCallback(argv: launchArguments, authScheme: config.identity.authScheme) {
            handleAuthCallback(callback)
            return
        }
        // Setup is always required until the auth session and Computer Use host
        // runtime land in the Swift shell, so open the main window on launch.
        showMainWindow()
    }

    private func runSmokeTest() {
        // Mirrors `desktop-smoke-test.ts`: prove the shell reached the ready
        // state, then exit so packaging CI can assert on the output.
        _ = DesktopTrayMenu.buildItems(trayMenuState(), actions: trayActions())
        let window = ensureMainWindow()
        _ = window.window.contentView
        FileHandle.standardOutput.write(Data("[smoke-test] desktop main ready\n".utf8))
        exit(0)
    }

    func handleOpenURL(_ rawUrl: String) {
        if let callback = DesktopAuthURLs.parseCallback(rawUrl, authScheme: config.identity.authScheme) {
            handleAuthCallback(callback)
            return
        }
        NSLog("Ignoring unexpected URL open request: \(rawUrl)")
    }

    private func handleAuthCallback(_ callback: DesktopAuthCallback) {
        authStartGate.suppressRetry()
        // The WebKit consume flow is the next port step; until then keep the
        // callback visible so the hand-off can be verified end to end.
        shellState.lastAuthCallbackHandoffId = callback.handoffId ?? "(none)"
        showMainWindow()
    }

    func applicationShouldTerminate() -> NSApplication.TerminateReply {
        if quitConfirmation.isQuitAllowed || appIsQuitting {
            keepAwake.release()
            return .terminateNow
        }
        Task { await self.quitConfirmation.requestQuit() }
        return .terminateCancel
    }

    func requestQuit() {
        Task { await self.quitConfirmation.requestQuit() }
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
        let controller = ensureMainWindow()
        controller.showAndFocus()
    }

    func mainWindowDidHide() {
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: Menu bar

    private func installApplicationMenu() {
        let displayName = config.identity.displayName
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: displayName)
        appMenu.addItem(withTitle: "About \(displayName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let updates = appMenu.addItem(withTitle: "Check for Updates...", action: nil, keyEquivalent: "")
        updates.isEnabled = false
        appMenu.addItem(.separator())
        let quitItem = ClosureMenuItem(title: "Quit \(displayName)", keyEquivalent: "q") { [weak self] in
            self?.requestQuit()
        }
        appMenu.addItem(quitItem)
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
            getComputerUseState: { [weak self] in self?.computerUseState() ?? DesktopAppRuntime.placeholderComputerUseState },
            buildMenuItems: { [weak self] in
                guard let self else { return [] }
                return DesktopTrayMenu.buildItems(self.trayMenuState(), actions: self.trayActions())
            }
        )
        tray.install()
        self.tray = tray
    }

    static let placeholderComputerUseState = DesktopComputerUseState(
        platform: "darwin", supported: true, deviceName: nil, permissions: .none,
        host: .offline, keepAwake: DesktopKeepAwakeState(enabled: false, active: false), plugins: nil
    )

    func computerUseState() -> DesktopComputerUseState {
        DesktopComputerUseState(
            platform: "darwin",
            supported: true,
            deviceName: shellState.deviceName,
            permissions: shellState.permissions,
            host: shellState.host,
            keepAwake: keepAwake.state,
            plugins: nil
        )
    }

    private func trayMenuState() -> DesktopTrayMenuState {
        DesktopTrayMenuState(
            brandName: config.identity.brandName,
            computerUse: computerUseState(),
            auth: shellState.auth,
            authLoading: false,
            authError: nil,
            recorder: nil
        )
    }

    private func trayActions() -> DesktopTrayMenuActions {
        DesktopTrayMenuActions(
            showMainWindow: { [weak self] in self?.showMainWindow() },
            startComputerUse: {},
            stopComputerUse: {},
            refreshStatus: { [weak self] in self?.notifyComputerUseChanged() },
            openSignIn: { [weak self] in self?.openSignIn() },
            switchWorkspace: {},
            signOut: {},
            requestAccessibilityPermission: {},
            requestScreenRecordingPermission: {},
            openAccessibilitySettings: { DesktopSystemSettings.open(.accessibility) },
            openScreenRecordingSettings: { DesktopSystemSettings.open(.screenRecording) },
            setKeepAwakeEnabled: { [weak self] enabled in self?.setKeepAwakeEnabled(enabled) },
            startScreenRecording: {},
            stopScreenRecording: {},
            retryScreenRecordingDelivery: {},
            quit: { [weak self] in self?.requestQuit() }
        )
    }

    // MARK: Actions

    func openSignIn() {
        guard authStartGate.shouldOpen() else { return }
        let url = DesktopAuthURLs.startUrl(webUrl: config.webUrl, authScheme: config.identity.authScheme)
        if let parsed = URL(string: url) {
            NSWorkspace.shared.open(parsed)
        }
    }

    func setKeepAwakeEnabled(_ enabled: Bool) {
        do {
            try keepAwake.setEnabled(enabled)
        } catch {
            NSLog("Desktop keep-awake preference failed to save: \(error)")
        }
        notifyComputerUseChanged()
    }

    func notifyComputerUseChanged() {
        shellState.keepAwake = keepAwake.state
        tray?.refresh()
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
