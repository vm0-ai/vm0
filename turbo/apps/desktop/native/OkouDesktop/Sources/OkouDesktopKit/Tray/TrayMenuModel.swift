import Foundation

public enum DesktopTrayMenuItemType: String, Sendable {
    case checkbox
    case separator
}

/// A platform-neutral menu item; the app maps these onto `NSMenuItem`.
public struct DesktopTrayMenuItem {
    public var label: String?
    public var type: DesktopTrayMenuItemType?
    public var checked: Bool?
    public var enabled: Bool?
    public var submenu: [DesktopTrayMenuItem]?
    public var click: (() -> Void)?

    public init(
        label: String? = nil, type: DesktopTrayMenuItemType? = nil, checked: Bool? = nil, enabled: Bool? = nil,
        submenu: [DesktopTrayMenuItem]? = nil, click: (() -> Void)? = nil
    ) {
        self.label = label
        self.type = type
        self.checked = checked
        self.enabled = enabled
        self.submenu = submenu
        self.click = click
    }

    /// Structural signature with closures rendered as `[function]`, used to
    /// skip rebuilding an unchanged menu.
    public var signature: JSONValue {
        var object: [String: JSONValue] = [:]
        if let label { object["label"] = .string(label) }
        if let type { object["type"] = .string(type.rawValue) }
        if let checked { object["checked"] = .bool(checked) }
        if let enabled { object["enabled"] = .bool(enabled) }
        if let submenu { object["submenu"] = .array(submenu.map(\.signature)) }
        if click != nil { object["click"] = .string("[function]") }
        return .object(object)
    }
}

public struct DesktopTrayMenuActions {
    public var showMainWindow: () -> Void
    public var startComputerUse: () -> Void
    public var stopComputerUse: () -> Void
    public var refreshStatus: () -> Void
    public var openSignIn: () -> Void
    public var switchWorkspace: () -> Void
    public var signOut: () -> Void
    public var requestAccessibilityPermission: () -> Void
    public var requestScreenRecordingPermission: () -> Void
    public var openAccessibilitySettings: () -> Void
    public var openScreenRecordingSettings: () -> Void
    public var setKeepAwakeEnabled: (Bool) -> Void
    public var startScreenRecording: () -> Void
    public var stopScreenRecording: () -> Void
    public var retryScreenRecordingDelivery: () -> Void
    public var quit: () -> Void

    public init(
        showMainWindow: @escaping () -> Void, startComputerUse: @escaping () -> Void,
        stopComputerUse: @escaping () -> Void, refreshStatus: @escaping () -> Void,
        openSignIn: @escaping () -> Void, switchWorkspace: @escaping () -> Void, signOut: @escaping () -> Void,
        requestAccessibilityPermission: @escaping () -> Void, requestScreenRecordingPermission: @escaping () -> Void,
        openAccessibilitySettings: @escaping () -> Void, openScreenRecordingSettings: @escaping () -> Void,
        setKeepAwakeEnabled: @escaping (Bool) -> Void, startScreenRecording: @escaping () -> Void,
        stopScreenRecording: @escaping () -> Void, retryScreenRecordingDelivery: @escaping () -> Void,
        quit: @escaping () -> Void
    ) {
        self.showMainWindow = showMainWindow
        self.startComputerUse = startComputerUse
        self.stopComputerUse = stopComputerUse
        self.refreshStatus = refreshStatus
        self.openSignIn = openSignIn
        self.switchWorkspace = switchWorkspace
        self.signOut = signOut
        self.requestAccessibilityPermission = requestAccessibilityPermission
        self.requestScreenRecordingPermission = requestScreenRecordingPermission
        self.openAccessibilitySettings = openAccessibilitySettings
        self.openScreenRecordingSettings = openScreenRecordingSettings
        self.setKeepAwakeEnabled = setKeepAwakeEnabled
        self.startScreenRecording = startScreenRecording
        self.stopScreenRecording = stopScreenRecording
        self.retryScreenRecordingDelivery = retryScreenRecordingDelivery
        self.quit = quit
    }
}

public struct DesktopTrayMenuState {
    public var brandName: DesktopBrandName?
    public var computerUse: DesktopComputerUseState
    public var auth: DesktopAuthState?
    public var authLoading: Bool
    public var authError: String?
    /// Absent unless intro video and native screen recording are both enabled.
    public var recorder: DesktopRecorderState?

    public init(
        brandName: DesktopBrandName? = nil, computerUse: DesktopComputerUseState, auth: DesktopAuthState?,
        authLoading: Bool = false, authError: String?, recorder: DesktopRecorderState? = nil
    ) {
        self.brandName = brandName
        self.computerUse = computerUse
        self.auth = auth
        self.authLoading = authLoading
        self.authError = authError
        self.recorder = recorder
    }
}

/// Port of `desktop-tray-menu.ts`: the full menu-bar state matrix.
public enum DesktopTrayMenu {
    public static let hostStatusLabels: [ComputerUseHostRuntimeStatus: String] = [
        .offline: "Offline",
        .connecting: "Starting...",
        .online: "Online",
        .recovering: "Recovering",
        .unauthenticated: "Sign in required",
        .needsOrganization: "Select workspace",
        .disabled: "Disabled",
        .error: "Error",
    ]

    public static let commandStatusLabels: [ComputerUseLocalCommandLogStatus: String] = [
        .running: "Running",
        .succeeded: "Succeeded",
        .failed: "Failed",
    ]

    public static let maxRecentCommands = 5
    public static let maxCommandLabelLength = 90

    /// Errors that leave an undelivered capture on disk. `signed_out` is
    /// raised before anything is captured, so retrying on it would re-upload
    /// an unrelated, already delivered recording.
    public static let undeliveredRecordingErrorCodes: Set<DesktopRecorderErrorCode> = [
        .captureFailed, .deliveryFailed, .sourceLost,
    ]

    static func brandName(_ state: DesktopTrayMenuState) -> String {
        (state.brandName ?? .zero).rawValue
    }

    static func separator() -> DesktopTrayMenuItem {
        DesktopTrayMenuItem(type: .separator)
    }

    static func disabledLabel(_ label: String) -> DesktopTrayMenuItem {
        DesktopTrayMenuItem(label: label, enabled: false)
    }

    static func isAuthLoading(_ state: DesktopTrayMenuState) -> Bool {
        if state.authLoading { return true }
        if case .signingIn = state.auth { return true }
        return false
    }

    public static func computerUseStatusLabel(_ state: DesktopTrayMenuState) -> String {
        if !state.computerUse.supported {
            return "Unsupported"
        }
        if !state.computerUse.permissions.hasRequired {
            return "Needs permissions"
        }
        if state.computerUse.host.status != .offline {
            return hostStatusLabels[state.computerUse.host.status]!
        }
        if isAuthLoading(state) {
            return "Signing in..."
        }
        guard let auth = state.auth, auth.isSignedIn else {
            return "Sign in required"
        }
        if auth.organization == nil {
            return "Select workspace"
        }
        return hostStatusLabels[state.computerUse.host.status]!
    }

    static func canStartComputerUse(_ state: DesktopTrayMenuState) -> Bool {
        let status = state.computerUse.host.status
        return state.computerUse.supported && state.computerUse.permissions.hasRequired && !isAuthLoading(state)
            && (state.auth?.isReady ?? false) && status != .connecting && status != .online && status != .recovering
    }

    static func canStopComputerUse(_ state: DesktopTrayMenuState) -> Bool {
        let status = state.computerUse.host.status
        return state.computerUse.supported && (status == .online || status == .recovering)
    }

    static func authActionForComputerUse(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions) -> DesktopTrayMenuItem? {
        let status = state.computerUse.host.status
        if status == .online || status == .recovering {
            return nil
        }
        if isAuthLoading(state) {
            return disabledLabel("Signing in...")
        }
        if let auth = state.auth, auth.isSignedIn {
            if auth.organization == nil {
                return DesktopTrayMenuItem(label: "Select Workspace", click: actions.switchWorkspace)
            }
            return nil
        }
        return DesktopTrayMenuItem(label: "Sign in to \(brandName(state))", click: actions.openSignIn)
    }

    static func buildPermissionItems(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions) -> [DesktopTrayMenuItem] {
        var items: [DesktopTrayMenuItem] = []
        if state.computerUse.permissions.accessibility {
            items.append(disabledLabel("Accessibility: Ready"))
        } else {
            items.append(DesktopTrayMenuItem(label: "Request Accessibility Permission", click: actions.requestAccessibilityPermission))
        }
        items.append(DesktopTrayMenuItem(label: "Accessibility Settings", click: actions.openAccessibilitySettings))
        if state.computerUse.permissions.screenRecording {
            items.append(disabledLabel("Screen Recording: Ready"))
        } else {
            items.append(DesktopTrayMenuItem(label: "Request Screen Recording Permission", click: actions.requestScreenRecordingPermission))
        }
        items.append(DesktopTrayMenuItem(label: "Screen Recording Settings", click: actions.openScreenRecordingSettings))
        return items
    }

    static func buildComputerUseSubmenu(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions) -> [DesktopTrayMenuItem] {
        var items: [DesktopTrayMenuItem] = [disabledLabel("Status: \(computerUseStatusLabel(state))")]
        if !state.computerUse.supported {
            items.append(separator())
            items.append(DesktopTrayMenuItem(label: "Refresh Status", click: actions.refreshStatus))
            return items
        }
        items.append(separator())
        items.append(contentsOf: buildPermissionItems(state, actions))
        if !state.computerUse.permissions.hasRequired {
            items.append(separator())
            items.append(DesktopTrayMenuItem(label: "Refresh Status", click: actions.refreshStatus))
            return items
        }
        items.append(separator())
        items.append(DesktopTrayMenuItem(label: "Start Computer Use", enabled: canStartComputerUse(state), click: actions.startComputerUse))
        items.append(DesktopTrayMenuItem(label: "Stop Computer Use", enabled: canStopComputerUse(state), click: actions.stopComputerUse))
        if let authAction = authActionForComputerUse(state, actions) {
            items.append(authAction)
        }
        items.append(DesktopTrayMenuItem(label: "Refresh Status", click: actions.refreshStatus))
        return items
    }

    public static func authStatusLabel(_ state: DesktopTrayMenuState) -> String {
        if isAuthLoading(state) {
            return "Signing in to \(brandName(state))..."
        }
        if state.authError != nil {
            return "Sign in to \(brandName(state))"
        }
        guard let auth = state.auth else {
            return "Sign in to \(brandName(state))"
        }
        if case .signedOut = auth {
            return "Sign in to \(brandName(state))"
        }
        guard let organization = auth.organization else {
            return "Select Workspace"
        }
        return "Workspace: \(organization.name)"
    }

    static func buildAuthSubmenu(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions) -> [DesktopTrayMenuItem] {
        if isAuthLoading(state) {
            return [disabledLabel("Signing in...")]
        }
        let signedOutItems = [
            disabledLabel("Not signed in"),
            DesktopTrayMenuItem(label: "Sign in to \(brandName(state))", click: actions.openSignIn),
            DesktopTrayMenuItem(label: "Refresh Account Status", click: actions.refreshStatus),
        ]
        guard state.authError == nil, let auth = state.auth else {
            return signedOutItems
        }
        switch auth {
        case .signedOut:
            return signedOutItems
        case .signingIn:
            return [disabledLabel("Signing in...")]
        case let .signedIn(user, organization):
            return [
                disabledLabel("Signed in as \(user.email)"),
                disabledLabel("Workspace: \(organization?.name ?? "Not selected")"),
                separator(),
                DesktopTrayMenuItem(label: "Switch Workspace", click: actions.switchWorkspace),
                DesktopTrayMenuItem(label: "Sign out", click: actions.signOut),
            ]
        }
    }

    static func pad(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }

    /// `running` when unfinished, `HH:MM` today, `MM/DD` this year, else `YYYY/MM/DD`.
    public static func formatTrayTimestamp(_ value: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let value else { return "running" }
        guard let date = ISOTimestamp.date(from: value) else { return value }
        let dateParts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let nowParts = calendar.dateComponents([.year, .month, .day], from: now)
        if dateParts.year != nowParts.year || dateParts.month != nowParts.month || dateParts.day != nowParts.day {
            let monthDay = "\(pad(dateParts.month!))/\(pad(dateParts.day!))"
            if dateParts.year == nowParts.year {
                return monthDay
            }
            return "\(dateParts.year!)/\(monthDay)"
        }
        return "\(pad(dateParts.hour!)):\(pad(dateParts.minute!))"
    }

    public static func truncateMenuLabel(_ value: String) -> String {
        if value.count <= maxCommandLabelLength {
            return value
        }
        return String(value.prefix(maxCommandLabelLength - 3)) + "..."
    }

    static func formatRecentCommandLabel(_ entry: ComputerUseLocalCommandLogEntry, now: Date) -> String {
        let target = entry.app.map { "\($0) - " } ?? ""
        let timestamp = formatTrayTimestamp(entry.completedAt ?? entry.startedAt, now: now)
        return truncateMenuLabel("\(timestamp) - \(target)\(entry.kind) - \(commandStatusLabels[entry.status]!)")
    }

    static func buildRecentCommandSection(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions, now: Date) -> [DesktopTrayMenuItem] {
        let commands = Array(state.computerUse.host.localCommandLog.prefix(maxRecentCommands))
        if commands.isEmpty {
            return [disabledLabel("No Recent Commands")]
        }
        var items = [disabledLabel("Recent Commands")]
        for entry in commands {
            items.append(DesktopTrayMenuItem(label: formatRecentCommandLabel(entry, now: now), click: actions.showMainWindow))
        }
        return items
    }

    public static func formatRecordingElapsed(_ elapsedMs: Double) -> String {
        let totalSeconds = max(0, Int((elapsedMs / 1000).rounded(.down)))
        return "\(pad(totalSeconds / 60)):\(pad(totalSeconds % 60))"
    }

    public static func screenRecordingStatusLabel(_ recorder: DesktopRecorderState) -> String {
        switch recorder.status {
        case .recording: return formatRecordingElapsed(recorder.elapsedMs)
        case .paused: return "\(formatRecordingElapsed(recorder.elapsedMs)) paused"
        case .preparing: return "Starting..."
        case .finalizing: return "Saving..."
        case .delivering: return "Uploading..."
        case .ready: return "Ready"
        case .idle, .unavailable: return recorder.error != nil ? "Failed" : "Ready"
        }
    }

    static func buildScreenRecordingSubmenu(_ recorder: DesktopRecorderState, _ actions: DesktopTrayMenuActions) -> [DesktopTrayMenuItem] {
        var items: [DesktopTrayMenuItem] = []
        if recorder.status == .recording || recorder.status == .paused {
            items.append(DesktopTrayMenuItem(label: "Stop Recording (\(DesktopRecorderShortcut.stopAcceleratorLabel))", click: actions.stopScreenRecording))
        } else if recorder.status == .idle {
            items.append(DesktopTrayMenuItem(label: "New Recording...", click: actions.startScreenRecording))
        } else {
            items.append(disabledLabel(screenRecordingStatusLabel(recorder)))
        }
        if let error = recorder.error {
            items.append(separator())
            items.append(disabledLabel(truncateMenuLabel(error.message)))
            if undeliveredRecordingErrorCodes.contains(error.code), recorder.lastRecording != nil {
                items.append(DesktopTrayMenuItem(label: "Retry Delivery", click: actions.retryScreenRecordingDelivery))
            }
        }
        return items
    }

    static func buildScreenRecordingSection(_ state: DesktopTrayMenuState, _ actions: DesktopTrayMenuActions) -> [DesktopTrayMenuItem] {
        guard let recorder = state.recorder, recorder.available else {
            return []
        }
        return [
            DesktopTrayMenuItem(
                label: "Screen Recording: \(screenRecordingStatusLabel(recorder))",
                submenu: buildScreenRecordingSubmenu(recorder, actions)
            )
        ]
    }

    public static func buildItems(_ state: DesktopTrayMenuState, actions: DesktopTrayMenuActions, now: Date = Date()) -> [DesktopTrayMenuItem] {
        let keepAwakeEnabled = state.computerUse.keepAwake.enabled
        var items: [DesktopTrayMenuItem] = [
            DesktopTrayMenuItem(label: "Open \(brandName(state))", click: actions.showMainWindow),
            DesktopTrayMenuItem(label: authStatusLabel(state), submenu: buildAuthSubmenu(state, actions)),
            separator(),
            DesktopTrayMenuItem(label: "Computer Use: \(computerUseStatusLabel(state))", submenu: buildComputerUseSubmenu(state, actions)),
            DesktopTrayMenuItem(
                label: "Keep Mac Awake", type: .checkbox, checked: keepAwakeEnabled,
                click: { actions.setKeepAwakeEnabled(!keepAwakeEnabled) }
            ),
        ]
        items.append(contentsOf: buildScreenRecordingSection(state, actions))
        items.append(separator())
        items.append(contentsOf: buildRecentCommandSection(state, actions, now: now))
        items.append(separator())
        items.append(DesktopTrayMenuItem(label: "Quit", click: actions.quit))
        return items
    }
}
