import Foundation

/// Port of `computer-use-permissions.ts`: the cached permission state, with
/// the automation map preserved across helper refreshes because the helper
/// never reports it.
@MainActor
public final class ComputerUsePermissionStore {
    private let backend: ComputerUseNativeBackend
    public private(set) var state = ComputerUsePermissionState.none

    public init(backend: ComputerUseNativeBackend) {
        self.backend = backend
    }

    private func merge(_ permissions: ComputerUsePermissionState) -> ComputerUsePermissionState {
        var next = permissions
        next.automation = state.automation
        state = next
        return next
    }

    @discardableResult
    public func refresh() async throws -> ComputerUsePermissionState {
        merge(try await backend.getPermissions())
    }

    @discardableResult
    public func requestAccessibility() async throws -> ComputerUsePermissionState {
        merge(try await backend.requestAccessibilityPermission())
    }

    @discardableResult
    public func requestScreenRecording() async throws -> ComputerUsePermissionState {
        merge(try await backend.requestScreenRecordingPermission())
    }

    @discardableResult
    public func probeAutomation(_ target: ComputerUseAutomationPermissionTarget) async throws -> ComputerUsePermissionState {
        var result = try await backend.probeAutomationPermission(target)
        result.updatedAt = ISOTimestamp.now()
        state.automation[target] = result
        return state
    }

    @discardableResult
    public func recordAutomationDenied(_ target: ComputerUseAutomationPermissionTarget, reason: String) -> ComputerUsePermissionState {
        state.automation[target] = ComputerUseAutomationPermissionTargetState(status: .denied, updatedAt: ISOTimestamp.now(), reason: reason)
        return state
    }
}

public struct AutomationPermissionDialogOptions: Equatable, Sendable {
    public let title: String
    public let message: String
    public let detail: String
    public let buttons: [String]
    public let defaultButtonIndex: Int
    public let cancelButtonIndex: Int

    public static func build(sourceLabel: String, targetLabel: String) -> AutomationPermissionDialogOptions {
        AutomationPermissionDialogOptions(
            title: "Browser Automation Permission Required",
            message: "Allow \(sourceLabel) to control \(targetLabel)",
            detail: "Open System Settings > Privacy & Security > Automation and allow \(sourceLabel) to control \(targetLabel).",
            buttons: ["Open Automation Settings", "Not Now"],
            defaultButtonIndex: 0,
            cancelButtonIndex: 1
        )
    }
}

/// Port of `createAutomationPermissionDeniedPrompt`: records a denial and
/// prompts once per target for the process lifetime.
@MainActor
public final class AutomationPermissionPrompt {
    public static let settingsUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    static let targetLabels: [String: String] = ["com.apple.safari": "Safari", "com.google.chrome": "Google Chrome"]
    static let permissionTargets: [String: ComputerUseAutomationPermissionTarget] = ["com.apple.safari": .safari, "com.google.chrome": .chrome]

    private let sourceLabel: String
    private let showDialog: (AutomationPermissionDialogOptions) async -> Int
    private let openAutomationSettings: () -> Void
    private let onPermissionDenied: (ComputerUseAutomationPermissionTarget, String) -> Void
    private var promptedTargets: Set<String> = []

    public init(
        sourceLabel: String,
        showDialog: @escaping (AutomationPermissionDialogOptions) async -> Int,
        openAutomationSettings: @escaping () -> Void,
        onPermissionDenied: @escaping (ComputerUseAutomationPermissionTarget, String) -> Void
    ) {
        self.sourceLabel = sourceLabel
        self.showDialog = showDialog
        self.openAutomationSettings = openAutomationSettings
        self.onPermissionDenied = onPermissionDenied
    }

    public func handle(command: ComputerUseCommand, failure: ComputerUseCommandFailure) {
        guard failure.code == .automationPermissionDenied else { return }
        let key: String
        let label: String
        var permissionTarget: ComputerUseAutomationPermissionTarget? = nil
        if let app = command.app {
            key = app.lowercased()
            label = Self.targetLabels[key] ?? app
            permissionTarget = Self.permissionTargets[key]
        } else {
            key = "target-app"
            label = "the target app"
        }
        if let permissionTarget {
            onPermissionDenied(permissionTarget, failure.message)
        }
        if promptedTargets.contains(key) { return }
        promptedTargets.insert(key)
        let options = AutomationPermissionDialogOptions.build(sourceLabel: sourceLabel, targetLabel: label)
        Task { @MainActor in
            if await self.showDialog(options) == 0 {
                self.openAutomationSettings()
            }
        }
    }
}
