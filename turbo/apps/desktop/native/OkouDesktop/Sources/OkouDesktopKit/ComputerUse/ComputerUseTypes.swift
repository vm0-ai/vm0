import Foundation

public enum ComputerUseAutomationPermissionTarget: String, CaseIterable, Sendable, Codable {
    case chrome
    case safari

    public var bundleId: String {
        switch self {
        case .chrome: return "com.google.Chrome"
        case .safari: return "com.apple.Safari"
        }
    }

    public var label: String {
        switch self {
        case .chrome: return "Google Chrome"
        case .safari: return "Safari"
        }
    }
}

public enum ComputerUseAutomationPermissionStatus: String, Sendable, Codable {
    case unknown
    case granted
    case denied
    case notInstalled = "not_installed"
    case notRunning = "not_running"
}

public struct ComputerUseAutomationPermissionTargetState: Equatable, Sendable {
    public var status: ComputerUseAutomationPermissionStatus
    public var updatedAt: String?
    public var reason: String?

    public init(status: ComputerUseAutomationPermissionStatus, updatedAt: String?, reason: String?) {
        self.status = status
        self.updatedAt = updatedAt
        self.reason = reason
    }

    public static let unknown = ComputerUseAutomationPermissionTargetState(status: .unknown, updatedAt: nil, reason: nil)

    public var json: JSONValue {
        .object([
            "status": .string(status.rawValue),
            "updatedAt": updatedAt.map(JSONValue.string) ?? .null,
            "reason": reason.map(JSONValue.string) ?? .null,
        ])
    }
}

public struct ComputerUseAutomationPermissionState: Equatable, Sendable {
    public var chrome: ComputerUseAutomationPermissionTargetState
    public var safari: ComputerUseAutomationPermissionTargetState

    public init(chrome: ComputerUseAutomationPermissionTargetState, safari: ComputerUseAutomationPermissionTargetState) {
        self.chrome = chrome
        self.safari = safari
    }

    public static let unknown = ComputerUseAutomationPermissionState(chrome: .unknown, safari: .unknown)

    public subscript(target: ComputerUseAutomationPermissionTarget) -> ComputerUseAutomationPermissionTargetState {
        get {
            switch target {
            case .chrome: return chrome
            case .safari: return safari
            }
        }
        set {
            switch target {
            case .chrome: chrome = newValue
            case .safari: safari = newValue
            }
        }
    }

    public var json: JSONValue {
        .object(["chrome": chrome.json, "safari": safari.json])
    }
}

public struct ComputerUsePermissionState: Equatable, Sendable {
    public var accessibility: Bool
    public var screenRecording: Bool
    public var automation: ComputerUseAutomationPermissionState

    public init(
        accessibility: Bool,
        screenRecording: Bool,
        automation: ComputerUseAutomationPermissionState = .unknown
    ) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
        self.automation = automation
    }

    public static let none = ComputerUsePermissionState(accessibility: false, screenRecording: false)

    /// Accessibility and Screen Recording; Automation is not required to go online.
    public var hasRequired: Bool {
        accessibility && screenRecording
    }

    public var json: JSONValue {
        .object([
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecording),
            "automation": automation.json,
        ])
    }
}

public enum ComputerUseHostRuntimeStatus: String, Sendable, Codable {
    case offline
    case connecting
    case online
    case recovering
    case unauthenticated
    case needsOrganization = "needs_organization"
    case disabled
    case error
}

public enum ComputerUseRuntimeRecoveryPhase: String, Sendable, Codable {
    case start
    case heartbeat
    case commandPoll = "command_poll"
}

public struct ComputerUseRuntimeRecoveryState: Equatable, Sendable {
    public var phase: ComputerUseRuntimeRecoveryPhase
    public var attempt: Int
    public var nextRetryAt: String
    public var lastRetryAt: String
    public var retryDelayMs: Double

    public init(phase: ComputerUseRuntimeRecoveryPhase, attempt: Int, nextRetryAt: String, lastRetryAt: String, retryDelayMs: Double) {
        self.phase = phase
        self.attempt = attempt
        self.nextRetryAt = nextRetryAt
        self.lastRetryAt = lastRetryAt
        self.retryDelayMs = retryDelayMs
    }
}

public enum ComputerUseLocalCommandLogStatus: String, Sendable, Codable {
    case running
    case succeeded
    case failed
}

public struct ComputerUseLocalCommandLogEntry: Equatable, Sendable {
    public var commandId: String
    public var kind: String
    public var app: String?
    public var status: ComputerUseLocalCommandLogStatus
    public var payload: [String: JSONValue]
    public var result: [String: JSONValue]?
    public var error: [String: JSONValue]?
    public var startedAt: String
    public var completedAt: String?
    public var durationMs: Double?

    public init(
        commandId: String, kind: String, app: String?, status: ComputerUseLocalCommandLogStatus,
        payload: [String: JSONValue], result: [String: JSONValue]?, error: [String: JSONValue]?,
        startedAt: String, completedAt: String?, durationMs: Double?
    ) {
        self.commandId = commandId
        self.kind = kind
        self.app = app
        self.status = status
        self.payload = payload
        self.result = result
        self.error = error
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationMs = durationMs
    }
}

public enum ComputerUseRuntimeErrorSource: String, Sendable, Codable {
    case start
    case stop
    case heartbeat
    case commandPoll = "command_poll"
}

public struct ComputerUseRuntimeErrorLogEntry: Equatable, Sendable {
    public var id: String
    public var source: ComputerUseRuntimeErrorSource
    public var message: String
    public var occurredAt: String
    public var hostId: String?

    public init(id: String, source: ComputerUseRuntimeErrorSource, message: String, occurredAt: String, hostId: String?) {
        self.id = id
        self.source = source
        self.message = message
        self.occurredAt = occurredAt
        self.hostId = hostId
    }
}

public struct ComputerUseHostRuntimeState: Equatable, Sendable {
    public var status: ComputerUseHostRuntimeStatus
    public var hostId: String?
    public var lastHeartbeatAt: String?
    public var lastCommandAt: String?
    public var lastError: String?
    public var recovery: ComputerUseRuntimeRecoveryState?
    public var errorLog: [ComputerUseRuntimeErrorLogEntry]
    public var localCommandLog: [ComputerUseLocalCommandLogEntry]

    public init(
        status: ComputerUseHostRuntimeStatus, hostId: String? = nil, lastHeartbeatAt: String? = nil,
        lastCommandAt: String? = nil, lastError: String? = nil, recovery: ComputerUseRuntimeRecoveryState? = nil,
        errorLog: [ComputerUseRuntimeErrorLogEntry] = [], localCommandLog: [ComputerUseLocalCommandLogEntry] = []
    ) {
        self.status = status
        self.hostId = hostId
        self.lastHeartbeatAt = lastHeartbeatAt
        self.lastCommandAt = lastCommandAt
        self.lastError = lastError
        self.recovery = recovery
        self.errorLog = errorLog
        self.localCommandLog = localCommandLog
    }

    public static let offline = ComputerUseHostRuntimeState(status: .offline)
}

public struct DesktopKeepAwakeState: Equatable, Sendable {
    public var enabled: Bool
    public var active: Bool

    public init(enabled: Bool, active: Bool) {
        self.enabled = enabled
        self.active = active
    }
}

public enum DesktopComputerUsePluginStatus: String, Sendable, Codable {
    case disabled
    case starting
    case running
    case restarting
    case error
}

public struct DesktopComputerUseFilesystemPluginState: Equatable, Sendable {
    public var featureEnabled: Bool
    public var enabled: Bool
    public var allowedDirectories: [String]
    public var status: DesktopComputerUsePluginStatus
    public var lastError: String?
    public var version: String
    public var capabilities: [String]

    public init(
        featureEnabled: Bool, enabled: Bool, allowedDirectories: [String], status: DesktopComputerUsePluginStatus,
        lastError: String?, version: String, capabilities: [String]
    ) {
        self.featureEnabled = featureEnabled
        self.enabled = enabled
        self.allowedDirectories = allowedDirectories
        self.status = status
        self.lastError = lastError
        self.version = version
        self.capabilities = capabilities
    }
}

public enum DesktopComputerUseMcpTransport: String, Sendable, Codable {
    case stdio
    case http
}

public struct DesktopComputerUseMcpServerState: Equatable, Sendable {
    public var name: String
    public var transport: DesktopComputerUseMcpTransport
    public var enabled: Bool
    public var status: DesktopComputerUsePluginStatus
    public var lastError: String?
    public var tools: [String]

    public init(
        name: String, transport: DesktopComputerUseMcpTransport, enabled: Bool,
        status: DesktopComputerUsePluginStatus, lastError: String?, tools: [String]
    ) {
        self.name = name
        self.transport = transport
        self.enabled = enabled
        self.status = status
        self.lastError = lastError
        self.tools = tools
    }
}

public struct DesktopComputerUseMcpPluginState: Equatable, Sendable {
    public var featureEnabled: Bool
    public var servers: [DesktopComputerUseMcpServerState]

    public init(featureEnabled: Bool, servers: [DesktopComputerUseMcpServerState]) {
        self.featureEnabled = featureEnabled
        self.servers = servers
    }
}

public struct DesktopComputerUsePluginsState: Equatable, Sendable {
    public var filesystem: DesktopComputerUseFilesystemPluginState
    public var mcp: DesktopComputerUseMcpPluginState

    public init(filesystem: DesktopComputerUseFilesystemPluginState, mcp: DesktopComputerUseMcpPluginState) {
        self.filesystem = filesystem
        self.mcp = mcp
    }
}

/// The state the UI and tray render. Port of `DesktopComputerUseState`.
public struct DesktopComputerUseState: Equatable, Sendable {
    public var platform: String
    public var supported: Bool
    public var deviceName: String?
    public var permissions: ComputerUsePermissionState
    public var host: ComputerUseHostRuntimeState
    public var keepAwake: DesktopKeepAwakeState
    public var plugins: DesktopComputerUsePluginsState?

    public init(
        platform: String, supported: Bool, deviceName: String?, permissions: ComputerUsePermissionState,
        host: ComputerUseHostRuntimeState, keepAwake: DesktopKeepAwakeState, plugins: DesktopComputerUsePluginsState?
    ) {
        self.platform = platform
        self.supported = supported
        self.deviceName = deviceName
        self.permissions = permissions
        self.host = host
        self.keepAwake = keepAwake
        self.plugins = plugins
    }
}
