import Foundation

/// A failure reported by, or about, the native Computer Use helper.
public struct ComputerUseNativeHelperError: Error, Equatable, Sendable, CustomStringConvertible {
    public var code: ComputerUseErrorCode
    public var message: String

    public init(code: ComputerUseErrorCode = .accessibilityUnavailable, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { message }
}

public enum ComputerUseNativeShutdownReason: String, Sendable {
    case dispose
    case appQuit = "app_quit"
    case updateRelaunch = "update_relaunch"
}

public struct ComputerUseNativeAppRecord: Equatable, Sendable {
    public var name: String
    public var bundleId: String?
    public var appPath: String?
    public var running: Bool?
    public var pid: Int?

    public init(name: String, bundleId: String? = nil, appPath: String? = nil, running: Bool? = nil, pid: Int? = nil) {
        self.name = name
        self.bundleId = bundleId
        self.appPath = appPath
        self.running = running
        self.pid = pid
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = ["name": .string(name)]
        if let bundleId { object["bundleId"] = .string(bundleId) }
        if let appPath { object["appPath"] = .string(appPath) }
        if let running { object["running"] = .bool(running) }
        if let pid { object["pid"] = .number(Double(pid)) }
        return .object(object)
    }
}

public struct ComputerUseNativeClickPointRequest: Sendable {
    public var app: String
    public var snapshotId: String
    public var x: Double
    public var y: Double
    public var screenshotSource: String
    public var screenshotWidth: Double
    public var screenshotHeight: Double
    public var sourceBounds: ComputerUseCoordinateBounds?
    public var windowId: Int?
    public var windowFrame: ComputerUseCoordinateBounds?
    public var button: ComputerUseMouseButton
    public var clickCount: Int
    public var foregroundRecovery: ComputerUseForegroundRecoveryPolicy

    public init(
        app: String, snapshotId: String, x: Double, y: Double, screenshotSource: String, screenshotWidth: Double,
        screenshotHeight: Double, sourceBounds: ComputerUseCoordinateBounds?, windowId: Int?,
        windowFrame: ComputerUseCoordinateBounds?, button: ComputerUseMouseButton, clickCount: Int,
        foregroundRecovery: ComputerUseForegroundRecoveryPolicy
    ) {
        self.app = app
        self.snapshotId = snapshotId
        self.x = x
        self.y = y
        self.screenshotSource = screenshotSource
        self.screenshotWidth = screenshotWidth
        self.screenshotHeight = screenshotHeight
        self.sourceBounds = sourceBounds
        self.windowId = windowId
        self.windowFrame = windowFrame
        self.button = button
        self.clickCount = clickCount
        self.foregroundRecovery = foregroundRecovery
    }
}

public struct ComputerUseElementTarget: Equatable, Sendable {
    public var elementId: String?
    public var elementIndex: Int?
    public var snapshotId: String?

    public init(elementId: String?, elementIndex: Int? = nil, snapshotId: String? = nil) {
        self.elementId = elementId
        self.elementIndex = elementIndex
        self.snapshotId = snapshotId
    }

    var payload: [String: JSONValue] {
        var object: [String: JSONValue] = [:]
        if let elementId { object["elementId"] = .string(elementId) }
        if let elementIndex { object["elementIndex"] = .number(Double(elementIndex)) }
        if let snapshotId { object["snapshotId"] = .string(snapshotId) }
        return object
    }
}

/// The native helper as the command executor sees it: one JSON request in,
/// one result object out. Port of `ComputerUseNativeBackend`.
public protocol ComputerUseNativeBackend: AnyObject, Sendable {
    func dispose(reason: ComputerUseNativeShutdownReason) async
    /// Sends `{kind, payload}` and returns the helper's `result` object.
    func run(kind: String, payload: [String: JSONValue]) async throws -> [String: JSONValue]
}

extension ComputerUseNativeBackend {
    public func getPermissions() async throws -> ComputerUsePermissionState {
        try NativeHelperResults.permissions(try await run(kind: "permissions.state", payload: [:]))
    }

    public func requestAccessibilityPermission() async throws -> ComputerUsePermissionState {
        try NativeHelperResults.permissions(try await run(kind: "permissions.request_accessibility", payload: [:]))
    }

    public func requestScreenRecordingPermission() async throws -> ComputerUsePermissionState {
        try NativeHelperResults.permissions(try await run(kind: "permissions.request_screen_recording", payload: [:]))
    }

    public func probeAutomationPermission(_ target: ComputerUseAutomationPermissionTarget) async throws
        -> ComputerUseAutomationPermissionTargetState
    {
        NativeHelperResults.automationPermissionTargetState(
            try await run(kind: "permissions.probe_automation", payload: ["target": .string(target.rawValue)])
        )
    }

    public func listApps() async throws -> [ComputerUseNativeAppRecord] {
        try NativeHelperResults.appRecords(try await run(kind: "apps.list", payload: [:]))
    }

    public func getAppState(app: String, snapshotId: String, settle: Bool) async throws -> AccessibilityAppStateSnapshot {
        var payload: [String: JSONValue] = ["app": .string(app), "snapshotId": .string(snapshotId)]
        if settle { payload["settle"] = .bool(true) }
        return try NativeHelperResults.appStateSnapshot(try await run(kind: "app.state", payload: payload))
    }

    public func openApp(_ app: String) async throws -> [String: JSONValue] {
        try await run(kind: "app.open", payload: ["app": .string(app)])
    }

    public func clickElement(
        app: String, target: ComputerUseElementTarget, button: ComputerUseMouseButton, clickCount: Int,
        foregroundRecovery: ComputerUseForegroundRecoveryPolicy
    ) async throws -> [String: JSONValue] {
        var payload = target.payload
        payload["app"] = .string(app)
        payload["button"] = .string(button.rawValue)
        payload["clickCount"] = .number(Double(clickCount))
        payload["foregroundRecovery"] = .string(foregroundRecovery.rawValue)
        return try await run(kind: "element.click", payload: payload)
    }

    public func clickPoint(_ request: ComputerUseNativeClickPointRequest) async throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "app": .string(request.app),
            "snapshotId": .string(request.snapshotId),
            "x": .number(request.x),
            "y": .number(request.y),
            "screenshotSource": .string(request.screenshotSource),
            "screenshotWidth": .number(request.screenshotWidth),
            "screenshotHeight": .number(request.screenshotHeight),
            "button": .string(request.button.rawValue),
            "clickCount": .number(Double(request.clickCount)),
            "foregroundRecovery": .string(request.foregroundRecovery.rawValue),
        ]
        if let sourceBounds = request.sourceBounds { payload["sourceBounds"] = sourceBounds.json }
        if let windowId = request.windowId { payload["windowId"] = .number(Double(windowId)) }
        if let windowFrame = request.windowFrame { payload["windowFrame"] = windowFrame.json }
        let result = try await run(kind: "element.click", payload: payload)
        _ = try NativeHelperResults.requiredNumber(result, "screenX")
        _ = try NativeHelperResults.requiredNumber(result, "screenY")
        return result
    }

    public func setElementValue(app: String, target: ComputerUseElementTarget, value: String) async throws -> [String: JSONValue] {
        var payload = target.payload
        payload["app"] = .string(app)
        payload["value"] = .string(value)
        return try await run(kind: "element.set_value", payload: payload)
    }

    public func performElementAction(app: String, target: ComputerUseElementTarget, action: String) async throws -> [String: JSONValue] {
        var payload = target.payload
        payload["app"] = .string(app)
        payload["action"] = .string(action)
        return try await run(kind: "element.perform_action", payload: payload)
    }

    public func typeText(
        app: String, snapshotId: String?, text: String, foregroundRecovery: ComputerUseForegroundRecoveryPolicy
    ) async throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "app": .string(app), "text": .string(text), "foregroundRecovery": .string(foregroundRecovery.rawValue),
        ]
        if let snapshotId { payload["snapshotId"] = .string(snapshotId) }
        return try await run(kind: "keyboard.type_text", payload: payload)
    }

    public func pressKey(
        app: String, snapshotId: String?, key: String, foregroundRecovery: ComputerUseForegroundRecoveryPolicy
    ) async throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "app": .string(app), "key": .string(key), "foregroundRecovery": .string(foregroundRecovery.rawValue),
        ]
        if let snapshotId { payload["snapshotId"] = .string(snapshotId) }
        let result = try await run(kind: "keyboard.press_key", payload: payload)
        _ = try NativeHelperResults.requiredString(result, "normalizedKey")
        return result
    }

    public func scrollElement(app: String, target: ComputerUseElementTarget, direction: String, pages: Double) async throws -> [String: JSONValue] {
        var payload = target.payload
        payload["app"] = .string(app)
        payload["direction"] = .string(direction)
        payload["pages"] = .number(pages)
        return try await run(kind: "element.scroll", payload: payload)
    }
}

/// Response validators shared by every backend implementation. Port of the
/// `result*` helpers in `computer-use-native.ts`.
public enum NativeHelperResults {
    public static func error(_ message: String) -> ComputerUseNativeHelperError {
        ComputerUseNativeHelperError(code: .accessibilityUnavailable, message: message)
    }

    public static func requiredString(_ result: [String: JSONValue], _ key: String) throws -> String {
        guard let value = result[key]?.stringValue, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw error("Native Computer Use helper returned invalid \(key)")
        }
        return value
    }

    public static func optionalString(_ result: [String: JSONValue], _ key: String) -> String? {
        guard let value = result[key]?.stringValue, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }

    public static func requiredNumber(_ result: [String: JSONValue], _ key: String) throws -> Double {
        guard let value = result[key]?.doubleValue, value.isFinite else {
            throw error("Native Computer Use helper returned invalid \(key)")
        }
        return value
    }

    public static func permissions(_ result: [String: JSONValue]) throws -> ComputerUsePermissionState {
        guard let accessibility = result["accessibility"]?.boolValue, let screenRecording = result["screenRecording"]?.boolValue
        else {
            throw error("Native Computer Use helper returned invalid permissions")
        }
        return ComputerUsePermissionState(accessibility: accessibility, screenRecording: screenRecording)
    }

    public static func automationPermissionTargetState(_ result: [String: JSONValue]) -> ComputerUseAutomationPermissionTargetState {
        let status = ComputerUseAutomationPermissionStatus(rawValue: result["status"]?.stringValue ?? "") ?? .unknown
        return ComputerUseAutomationPermissionTargetState(
            status: status,
            updatedAt: optionalString(result, "updatedAt"),
            reason: optionalString(result, "reason")
        )
    }

    public static func appRecords(_ result: [String: JSONValue]) throws -> [ComputerUseNativeAppRecord] {
        guard let apps = result["apps"]?.arrayValue else {
            throw error("Native Computer Use helper returned invalid apps")
        }
        return try apps.map { entry -> ComputerUseNativeAppRecord in
            if let name = entry.stringValue, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return ComputerUseNativeAppRecord(name: name)
            }
            guard let object = entry.objectValue else {
                throw error("Native Computer Use helper returned invalid app entry")
            }
            let pid = object["pid"]?.doubleValue.flatMap { $0.isFinite ? Int($0) : nil }
            return ComputerUseNativeAppRecord(
                name: try requiredString(object, "name"),
                bundleId: optionalString(object, "bundleId"),
                appPath: optionalString(object, "appPath"),
                running: object["running"]?.boolValue,
                pid: pid
            )
        }
    }

    public static func appStateSnapshot(_ result: [String: JSONValue]) throws -> AccessibilityAppStateSnapshot {
        _ = try requiredString(result, "app")
        _ = try requiredString(result, "snapshotId")
        guard let elements = result["elements"]?.arrayValue else {
            throw error("Native Computer Use helper returned invalid accessibility elements")
        }
        for element in elements where element.objectValue == nil {
            throw error("Native Computer Use helper returned invalid accessibility element")
        }
        guard let snapshot = AccessibilityAppStateSnapshot.parse(.object(result)) else {
            throw error("Native Computer Use helper returned invalid accessibility element")
        }
        return snapshot
    }

    /// Parses one helper response line or one-shot output.
    public enum Response: Equatable, Sendable {
        case succeeded([String: JSONValue])
        case failed(code: String?, message: String?)
    }

    public static func parseResponse(_ value: JSONValue) throws -> Response {
        guard let object = value.objectValue else {
            throw error("Native Computer Use helper returned a non-object response")
        }
        switch object["status"]?.stringValue {
        case "succeeded":
            if let result = object["result"] {
                guard let record = result.objectValue else {
                    throw error("Native Computer Use helper returned invalid result")
                }
                return .succeeded(record)
            }
            return .succeeded([:])
        case "failed":
            return .failed(code: object["error"]?["code"]?.stringValue, message: object["error"]?["message"]?.stringValue)
        default:
            throw error("Native Computer Use helper returned an invalid response status")
        }
    }

    public static func failure(code: String?, message: String?) -> ComputerUseNativeHelperError {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ComputerUseNativeHelperError(
            code: ComputerUseErrorCode.fromHelper(code),
            message: trimmed.isEmpty ? "Native Computer Use helper failed" : trimmed
        )
    }
}
