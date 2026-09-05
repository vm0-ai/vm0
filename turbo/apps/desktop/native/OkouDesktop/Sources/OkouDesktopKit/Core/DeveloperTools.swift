import Foundation

public struct DesktopDeveloperToolsState: Equatable, Sendable {
    public var available: Bool
    public var enabled: Bool

    public init(available: Bool, enabled: Bool) {
        self.available = available
        self.enabled = enabled
    }
}

/// Port of `DeveloperToolsController`: reads the feature switches that gate
/// the developer panels, the desktop plugins and the screen recorder.
@MainActor
public final class DesktopDeveloperToolsController {
    public static let debugSwitch = "_debug"
    public static let pluginsSwitch = "computerUseDesktopPlugins"
    public static let introVideoSwitch = "introVideo"
    public static let featureSwitchesPath = "/api/feature-switches"

    private let fetchFeatureSwitches: () async throws -> DesktopHTTPResponse
    private let setPluginsFeatureEnabled: (Bool) -> Void
    private let setScreenRecordingFeatureEnabled: (Bool) -> Void
    private let onChange: () -> Void
    private let logRefreshError: (Error) -> Void
    private var available = false
    private var enabled = false
    private var refreshTask: Task<Void, Never>? = nil
    private var rerunRequested = false

    public init(
        fetchFeatureSwitches: @escaping () async throws -> DesktopHTTPResponse,
        setPluginsFeatureEnabled: @escaping (Bool) -> Void,
        setScreenRecordingFeatureEnabled: @escaping (Bool) -> Void,
        onChange: @escaping () -> Void,
        logRefreshError: @escaping (Error) -> Void
    ) {
        self.fetchFeatureSwitches = fetchFeatureSwitches
        self.setPluginsFeatureEnabled = setPluginsFeatureEnabled
        self.setScreenRecordingFeatureEnabled = setScreenRecordingFeatureEnabled
        self.onChange = onChange
        self.logRefreshError = logRefreshError
    }

    public var state: DesktopDeveloperToolsState {
        DesktopDeveloperToolsState(available: available, enabled: available && enabled)
    }

    public func setEnabled(_ value: Bool) -> DesktopDeveloperToolsState {
        let next = available && value
        if enabled != next {
            enabled = next
            onChange()
        }
        return state
    }

    /// Coalesces concurrent requests onto the in-flight refresh plus one follow-up.
    public func requestRefresh() {
        if refreshTask != nil {
            rerunRequested = true
            return
        }
        refreshTask = Task { @MainActor in
            repeat {
                rerunRequested = false
                await refreshAvailability()
            } while rerunRequested
            refreshTask = nil
        }
    }

    static func switchValue(_ body: JSONValue, _ key: String) -> Bool {
        if let effective = body["effectiveSwitches"]?.objectValue {
            return effective[key]?.boolValue == true
        }
        return body["switches"]?[key]?.boolValue == true
    }

    private func refreshAvailability() async {
        do {
            let response = try await fetchFeatureSwitches()
            if response.status == 401 {
                apply(available: false, plugins: false, introVideo: false)
                return
            }
            guard response.ok else {
                throw DesktopConfigError("Desktop developer tools feature switch failed: \(response.status)")
            }
            let body = try response.json()
            apply(
                available: Self.switchValue(body, Self.debugSwitch),
                plugins: Self.switchValue(body, Self.pluginsSwitch),
                introVideo: Self.switchValue(body, Self.introVideoSwitch)
            )
        } catch {
            logRefreshError(error)
            apply(available: false, plugins: false, introVideo: false)
        }
    }

    private func apply(available: Bool, plugins: Bool, introVideo: Bool) {
        let previous = state
        self.available = available
        if !available {
            enabled = false
        }
        setPluginsFeatureEnabled(plugins)
        setScreenRecordingFeatureEnabled(introVideo)
        if previous != state {
            onChange()
        }
    }
}
