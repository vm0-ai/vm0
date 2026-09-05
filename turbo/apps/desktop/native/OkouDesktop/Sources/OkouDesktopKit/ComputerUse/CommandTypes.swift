import Foundation

/// A queued command from `POST /api/computer-use/host/commands/next`.
public struct ComputerUseCommand: Equatable, Sendable {
    public var id: String
    public var kind: String
    public var payload: [String: JSONValue]

    public init(id: String, kind: String, payload: [String: JSONValue]) {
        self.id = id
        self.kind = kind
        self.payload = payload
    }

    public static func parse(_ value: JSONValue) -> ComputerUseCommand? {
        guard let id = value["id"]?.stringValue, let kind = value["kind"]?.stringValue else {
            return nil
        }
        return ComputerUseCommand(id: id, kind: kind, payload: value["payload"]?.objectValue ?? [:])
    }

    public var app: String? {
        guard let value = payload["app"]?.stringValue else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Error codes the `complete` endpoint accepts.
public enum ComputerUseErrorCode: String, Sendable, Codable, CaseIterable {
    case permissionDenied = "permission_denied"
    case accessibilityUnavailable = "accessibility_unavailable"
    case automationPermissionDenied = "automation_permission_denied"
    case elementActionUnsupported = "element_action_unsupported"
    case elementNotEditable = "element_not_editable"
    case windowUnavailable = "window_unavailable"
    case screenRecordingUnavailable = "screen_recording_unavailable"
    case appNotFound = "app_not_found"
    case appOpenFailed = "app_open_failed"
    case unsupportedCommand = "unsupported_command"
    case commandTimeout = "command_timeout"
    case featureDisabled = "feature_disabled"
    case pluginDisabled = "plugin_disabled"
    case pluginUnavailable = "plugin_unavailable"
    case pluginRestarting = "plugin_restarting"
    case unknownPlugin = "unknown_plugin"
    case unknownTool = "unknown_tool"
    case invalidArguments = "invalid_arguments"
    case pathDenied = "path_denied"
    case resultTooLarge = "result_too_large"
    case inputTooLarge = "input_too_large"
    case mcpError = "mcp_error"

    /// The helper emits a few codes the API contract does not accept
    /// (`target_app_unresponsive`, `browser_navigation_failed`); anything
    /// outside this list is coerced to `accessibility_unavailable`.
    public static func fromHelper(_ raw: String?) -> ComputerUseErrorCode {
        switch raw {
        case "permission_denied": return .permissionDenied
        case "accessibility_unavailable": return .accessibilityUnavailable
        case "automation_permission_denied": return .automationPermissionDenied
        case "element_action_unsupported": return .elementActionUnsupported
        case "element_not_editable": return .elementNotEditable
        case "window_unavailable": return .windowUnavailable
        case "screen_recording_unavailable": return .screenRecordingUnavailable
        case "app_not_found": return .appNotFound
        case "app_open_failed": return .appOpenFailed
        case "unsupported_command": return .unsupportedCommand
        default: return .accessibilityUnavailable
        }
    }
}

public struct ComputerUseCommandFailure: Error, Equatable, Sendable {
    public var code: ComputerUseErrorCode
    public var message: String

    public init(code: ComputerUseErrorCode, message: String) {
        self.code = code
        self.message = message
    }

    public var json: JSONValue {
        .object(["code": .string(code.rawValue), "message": .string(message)])
    }
}

public enum ComputerUseCommandExecutionResult: Equatable, Sendable {
    case succeeded([String: JSONValue])
    case failed(ComputerUseCommandFailure)

    public var isSucceeded: Bool {
        if case .succeeded = self { return true }
        return false
    }

    public var result: [String: JSONValue]? {
        if case let .succeeded(result) = self { return result }
        return nil
    }

    public var failure: ComputerUseCommandFailure? {
        if case let .failed(failure) = self { return failure }
        return nil
    }

    /// Wire shape for `POST .../commands/:id/complete`.
    public var json: JSONValue {
        switch self {
        case let .succeeded(result):
            return .object(["status": .string("succeeded"), "result": .object(result)])
        case let .failed(failure):
            return .object(["status": .string("failed"), "error": failure.json])
        }
    }

    public static func failure(_ code: ComputerUseErrorCode, _ message: String) -> ComputerUseCommandExecutionResult {
        .failed(ComputerUseCommandFailure(code: code, message: message))
    }
}

public struct ComputerUseCoordinateBounds: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public init?(_ value: JSONValue?) {
        guard let x = value?["x"]?.doubleValue, let y = value?["y"]?.doubleValue,
            let width = value?["width"]?.doubleValue, let height = value?["height"]?.doubleValue
        else {
            return nil
        }
        self.init(x: x, y: y, width: width, height: height)
    }

    public var json: JSONValue {
        .object(["x": .number(x), "y": .number(y), "width": .number(width), "height": .number(height)])
    }
}

public enum ComputerUseMouseButton: String, Sendable {
    case left
    case right
    case middle
}

public enum ComputerUseForegroundRecoveryPolicy: String, Sendable {
    case never
    case onWindowUnavailable = "on-window-unavailable"
    case always
}

public enum ComputerUseCapabilities {
    public static let supported: [String] = [
        "apps.list",
        "app.state",
        "app.open",
        "element.click",
        "element.scroll",
        "element.set_value",
        "element.perform_action",
        "keyboard.type_text",
        "keyboard.press_key",
    ]
    public static let pluginCallKind = "plugin.call"
}
