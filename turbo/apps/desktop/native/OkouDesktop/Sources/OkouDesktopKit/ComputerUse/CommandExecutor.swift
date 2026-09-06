import Foundation

struct UnsupportedComputerUseCommandError: Error {
    let message: String
}

/// Port of `executeComputerUseCommand`: payload validation, snapshot
/// shaping, element index resolution, and the write-then-`app.state` rule.
public struct ComputerUseCommandExecutor: Sendable {
    public let backend: ComputerUseNativeBackend
    public let snapshotStore: ComputerUseSnapshotStore
    public let platform: String
    public let now: @Sendable () -> Double

    public init(
        backend: ComputerUseNativeBackend, snapshotStore: ComputerUseSnapshotStore, platform: String = "darwin",
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.backend = backend
        self.snapshotStore = snapshotStore
        self.platform = platform
        self.now = now
    }

    // MARK: Payload helpers

    static func payloadString(_ payload: [String: JSONValue], _ key: String) -> String? {
        guard let value = payload[key]?.stringValue else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func payloadNumber(_ payload: [String: JSONValue], _ key: String) -> Double? {
        guard let value = payload[key]?.doubleValue, value.isFinite else { return nil }
        return value
    }

    static func payloadElementIndex(_ payload: [String: JSONValue]) throws -> Int? {
        guard let value = payload["elementIndex"] else { return nil }
        if let index = value.intValue, index >= 0 {
            return index
        }
        throw UnsupportedComputerUseCommandError(message: "elementIndex must be a non-negative integer")
    }

    static func payloadMouseButton(_ payload: [String: JSONValue]) -> ComputerUseMouseButton {
        switch payload["button"]?.stringValue {
        case "right": return .right
        case "middle": return .middle
        default: return .left
        }
    }

    static func payloadClickCount(_ payload: [String: JSONValue]) -> Int {
        guard let value = payload["clickCount"]?.intValue, value >= 1, value <= 3 else { return 1 }
        return value
    }

    static func payloadForegroundRecovery(_ payload: [String: JSONValue]) throws -> ComputerUseForegroundRecoveryPolicy {
        guard let value = payloadString(payload, "foregroundRecovery") else { return .onWindowUnavailable }
        guard let policy = ComputerUseForegroundRecoveryPolicy(rawValue: value) else {
            throw UnsupportedComputerUseCommandError(message: "foregroundRecovery must be never, on-window-unavailable, or always")
        }
        return policy
    }

    func snapshotId() -> String {
        "desktop_" + String(Int64(now()), radix: 36)
    }

    static func unsupported(_ message: String) -> ComputerUseCommandExecutionResult {
        .failure(.unsupportedCommand, message)
    }

    static func missingField(_ field: String) -> ComputerUseCommandExecutionResult {
        .failure(.unsupportedCommand, "Missing required payload field: \(field)")
    }

    func requireAccessibility(_ permissions: ComputerUsePermissionState) -> ComputerUseCommandExecutionResult? {
        if platform != "darwin" {
            return .failure(.accessibilityUnavailable, "Desktop Computer Use is currently implemented for macOS")
        }
        if !permissions.accessibility {
            return .failure(.permissionDenied, "macOS Accessibility permission is required")
        }
        return nil
    }

    func requireScreenRecording(_ permissions: ComputerUsePermissionState) -> ComputerUseCommandExecutionResult? {
        if !permissions.screenRecording {
            return .failure(.screenRecordingUnavailable, "macOS Screen Recording permission is required")
        }
        return nil
    }

    // MARK: Screenshot contract

    struct AppStateScreenshot {
        var dataUrl: String
        var mimeType: String
        var source: String
        var sourceName: String
        var width: Double
        var height: Double
        var sourceBounds: ComputerUseCoordinateBounds?
    }

    static func screenshotFailure(_ message: String) -> ComputerUseCommandExecutionResult {
        .failure(.screenRecordingUnavailable, message)
    }

    static func nativeAppStateScreenshot(_ snapshot: AccessibilityAppStateSnapshot) -> Result<AppStateScreenshot, ComputerUseCommandFailure> {
        guard let screenshot = snapshot.screenshot, !screenshot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(ComputerUseCommandFailure(code: .screenRecordingUnavailable, message: "Native Computer Use app.state did not return a target-window screenshot"))
        }
        guard snapshot.screenshotSource == "window" else {
            return .failure(ComputerUseCommandFailure(code: .screenRecordingUnavailable, message: "Native Computer Use app.state must return a target-window screenshot"))
        }
        guard let sourceName = snapshot.screenshotSourceName, !sourceName.isEmpty else {
            return .failure(ComputerUseCommandFailure(code: .screenRecordingUnavailable, message: "Native Computer Use app.state did not return a screenshot source name"))
        }
        guard let width = snapshot.screenshotWidth, let height = snapshot.screenshotHeight, width > 0, height > 0 else {
            return .failure(ComputerUseCommandFailure(code: .screenRecordingUnavailable, message: "Native Computer Use app.state returned invalid screenshot dimensions"))
        }
        guard let sourceBounds = snapshot.screenshotSourceBounds else {
            return .failure(ComputerUseCommandFailure(code: .screenRecordingUnavailable, message: "Native Computer Use app.state did not return target-window screenshot bounds"))
        }
        return .success(
            AppStateScreenshot(
                dataUrl: screenshot, mimeType: snapshot.screenshotMimeType ?? "image/png", source: "window",
                sourceName: sourceName, width: width, height: height, sourceBounds: sourceBounds
            )
        )
    }

    static func buildAppStateResult(
        _ snapshot: AccessibilityAppStateSnapshot, screenshot: AppStateScreenshot, helperDurationMs: Double,
        settle: Bool, rawNodeCount: Int, nodeCount: Int
    ) -> [String: JSONValue] {
        let appState = AccessibilityShaping.render(snapshot)
        var result = snapshot.raw
        result["appState"] = .string(appState)
        result["metrics"] = .object([
            "helperDurationMs": .number(helperDurationMs),
            "settle": .bool(settle),
            "rawNodeCount": .number(Double(rawNodeCount)),
            "nodeCount": .number(Double(nodeCount)),
            "appStateChars": .number(Double(appState.count)),
        ])
        result["screenshot"] = .string(screenshot.dataUrl)
        result["screenshotMimeType"] = .string(screenshot.mimeType)
        result["screenshotSource"] = .string(screenshot.source)
        result["screenshotSourceName"] = .string(screenshot.sourceName)
        result["screenshotWidth"] = .number(screenshot.width)
        result["screenshotHeight"] = .number(screenshot.height)
        if let sourceBounds = screenshot.sourceBounds {
            result["screenshotSourceBounds"] = sourceBounds.json
        }
        return result
    }

    // MARK: Operations

    func listApps() async throws -> ComputerUseCommandExecutionResult {
        let apps = try await backend.listApps().sorted { left, right in
            let byName = left.name.compare(right.name, options: [.caseInsensitive, .diacriticInsensitive])
            if byName != .orderedSame {
                return byName == .orderedAscending
            }
            return (left.bundleId ?? "").compare(right.bundleId ?? "", options: [.caseInsensitive, .diacriticInsensitive]) == .orderedAscending
        }
        return .succeeded(["apps": .array(apps.map(\.json))])
    }

    func getAppState(app: String, settle: Bool = false) async throws -> ComputerUseCommandExecutionResult {
        let id = snapshotId()
        let helperStartedAt = now()
        let rawSnapshot = try await backend.getAppState(app: app, snapshotId: id, settle: settle)
        let helperDurationMs = now() - helperStartedAt
        let normalized = AccessibilityShaping.normalize(rawSnapshot)
        let indexed = AccessibilityShaping.index(normalized)
        let screenshot: AppStateScreenshot
        switch Self.nativeAppStateScreenshot(indexed.snapshot) {
        case let .failure(failure):
            return .failed(failure)
        case let .success(value):
            screenshot = value
        }
        snapshotStore.set(
            ComputerUseSnapshotMetadata(
                app: indexed.snapshot.app,
                snapshotId: indexed.snapshot.snapshotId,
                elementIdsByIndex: indexed.elementIdsByIndex,
                focusedElementIndex: indexed.focusedElementIndex,
                windowId: indexed.snapshot.windowId,
                windowFrame: indexed.snapshot.windowFrame,
                screenshotWidth: screenshot.width,
                screenshotHeight: screenshot.height,
                screenshotSource: screenshot.source,
                screenshotSourceName: screenshot.sourceName,
                sourceBounds: screenshot.sourceBounds
            )
        )
        return .succeeded(
            Self.buildAppStateResult(
                indexed.snapshot, screenshot: screenshot, helperDurationMs: helperDurationMs, settle: settle,
                rawNodeCount: rawSnapshot.elementCount, nodeCount: indexed.snapshot.elementCount
            )
        )
    }

    /// Every write command is followed by a settled `app.state`; the action's
    /// own result nests under `action`.
    func executeWriteAction(
        app: String, permissions: ComputerUsePermissionState,
        execute: () async throws -> ComputerUseCommandExecutionResult
    ) async throws -> ComputerUseCommandExecutionResult {
        if let failure = requireScreenRecording(permissions) {
            return failure
        }
        let actionResult = try await execute()
        guard case let .succeeded(actionRecord) = actionResult else {
            return actionResult
        }
        let appStateResult = try await getAppState(app: app, settle: true)
        guard case var .succeeded(result) = appStateResult else {
            return appStateResult
        }
        result["action"] = .object(actionRecord)
        return .succeeded(result)
    }

    func resolveClickSnapshot(app: String, snapshotId: String?) -> Result<ComputerUseSnapshotMetadata, ComputerUseCommandFailure> {
        if let snapshotId {
            if let snapshot = snapshotStore.get(app: app, snapshotId: snapshotId) {
                return .success(snapshot)
            }
            return .failure(ComputerUseCommandFailure(code: .unsupportedCommand, message: "Snapshot not found for \(app): \(snapshotId)"))
        }
        if let latest = snapshotStore.latest(app: app) {
            return .success(latest)
        }
        return .failure(ComputerUseCommandFailure(code: .unsupportedCommand, message: "No app state snapshot is available for \(app)"))
    }

    func resolveElementTarget(
        app: String, elementId: String?, elementIndex: Int?, snapshotId: String?, commandName: String
    ) -> Result<ComputerUseElementTarget, ComputerUseCommandFailure> {
        if let elementId {
            return .success(ComputerUseElementTarget(elementId: elementId))
        }
        guard let elementIndex else {
            return .failure(ComputerUseCommandFailure(code: .unsupportedCommand, message: "\(commandName) requires elementId or elementIndex"))
        }
        let snapshot: ComputerUseSnapshotMetadata
        switch resolveClickSnapshot(app: app, snapshotId: snapshotId) {
        case let .failure(failure): return .failure(failure)
        case let .success(value): snapshot = value
        }
        guard elementIndex < snapshot.elementIdsByIndex.count, !snapshot.elementIdsByIndex[elementIndex].isEmpty else {
            return .failure(ComputerUseCommandFailure(
                code: .unsupportedCommand,
                message: "Element index \(elementIndex) was not found in snapshot \(snapshot.snapshotId)"
            ))
        }
        return .success(ComputerUseElementTarget(
            elementId: snapshot.elementIdsByIndex[elementIndex], elementIndex: elementIndex, snapshotId: snapshot.snapshotId
        ))
    }

    static func targetResult(_ target: ComputerUseElementTarget) -> [String: JSONValue] {
        if let elementIndex = target.elementIndex {
            var object: [String: JSONValue] = ["elementIndex": .number(Double(elementIndex))]
            if let snapshotId = target.snapshotId { object["snapshotId"] = .string(snapshotId) }
            return object
        }
        if let elementId = target.elementId {
            return ["elementId": .string(elementId)]
        }
        return [:]
    }

    static func targetText(_ target: ComputerUseElementTarget) -> String {
        if let elementIndex = target.elementIndex { return "elementIndex=\(elementIndex)" }
        return target.elementId ?? "element"
    }

    static func merged(_ base: [String: JSONValue], _ native: [String: JSONValue], summary: String) -> [String: JSONValue] {
        var result = base
        for (key, value) in native {
            result[key] = value
        }
        result["summary"] = .string(summary)
        return result
    }

    func clickElement(
        app: String, elementId: String?, elementIndex: Int?, snapshotId: String?, x: Double?, y: Double?,
        button: ComputerUseMouseButton, clickCount: Int, foregroundRecovery: ComputerUseForegroundRecoveryPolicy
    ) async throws -> ComputerUseCommandExecutionResult {
        if elementId != nil || elementIndex != nil {
            if button != .left {
                return Self.unsupported("element.click with element target only supports the left button; use coordinates for right or middle clicks")
            }
            let target: ComputerUseElementTarget
            switch resolveElementTarget(app: app, elementId: elementId, elementIndex: elementIndex, snapshotId: snapshotId, commandName: "element.click") {
            case let .failure(failure): return .failed(failure)
            case let .success(value): target = value
            }
            let native = try await backend.clickElement(
                app: app, target: target, button: button, clickCount: clickCount, foregroundRecovery: foregroundRecovery
            )
            var base: [String: JSONValue] = ["app": .string(app)]
            for (key, value) in Self.targetResult(target) { base[key] = value }
            base["button"] = .string(button.rawValue)
            base["clickCount"] = .number(Double(clickCount))
            return .succeeded(Self.merged(base, native, summary: "Clicked \(Self.targetText(target))"))
        }
        if let x, let y {
            let snapshot: ComputerUseSnapshotMetadata
            switch resolveClickSnapshot(app: app, snapshotId: snapshotId) {
            case let .failure(failure): return .failed(failure)
            case let .success(value): snapshot = value
            }
            let native = try await backend.clickPoint(
                ComputerUseNativeClickPointRequest(
                    app: app, snapshotId: snapshot.snapshotId, x: x, y: y, screenshotSource: snapshot.screenshotSource,
                    screenshotWidth: snapshot.screenshotWidth, screenshotHeight: snapshot.screenshotHeight,
                    sourceBounds: snapshot.sourceBounds, windowId: snapshot.windowId, windowFrame: snapshot.windowFrame,
                    button: button, clickCount: clickCount, foregroundRecovery: foregroundRecovery
                )
            )
            let base: [String: JSONValue] = [
                "app": .string(app), "snapshotId": .string(snapshot.snapshotId), "x": .number(x), "y": .number(y),
                "screenX": native["screenX"] ?? .null, "screenY": native["screenY"] ?? .null,
                "button": .string(button.rawValue), "clickCount": .number(Double(clickCount)),
            ]
            return .succeeded(Self.merged(base, native, summary: "Clicked \(Self.formatCoordinate(x)),\(Self.formatCoordinate(y))"))
        }
        return Self.unsupported("element.click requires elementId, elementIndex, or coordinates")
    }

    static func formatCoordinate(_ value: Double) -> String {
        JSONValue.number(value).serialized()
    }

    // MARK: Entry point

    public func execute(_ command: ComputerUseCommand, permissions: ComputerUsePermissionState) async -> ComputerUseCommandExecutionResult {
        if let failure = requireAccessibility(permissions) {
            return failure
        }
        do {
            return try await executeSupported(command, permissions: permissions)
        } catch let error as UnsupportedComputerUseCommandError {
            return Self.unsupported(error.message)
        } catch let error as ComputerUseNativeHelperError {
            return .failure(error.code, error.message)
        } catch {
            return .failure(.accessibilityUnavailable, String(describing: error))
        }
    }

    private func executeSupported(_ command: ComputerUseCommand, permissions: ComputerUsePermissionState) async throws -> ComputerUseCommandExecutionResult {
        let payload = command.payload
        if command.kind == "apps.list" {
            return try await listApps()
        }
        guard let app = Self.payloadString(payload, "app") else {
            return Self.missingField("app")
        }
        switch command.kind {
        case "app.state":
            if let failure = requireScreenRecording(permissions) { return failure }
            return try await getAppState(app: app)
        case "app.open":
            return try await executeWriteAction(app: app, permissions: permissions) {
                let native = try await backend.openApp(app)
                return .succeeded(Self.merged(["app": .string(app)], native, summary: "Opened \(app)"))
            }
        case "element.click":
            let x = Self.payloadNumber(payload, "x")
            let y = Self.payloadNumber(payload, "y")
            let snapshotId = Self.payloadString(payload, "snapshotId")
            let elementId = Self.payloadString(payload, "elementId")
            let elementIndex = try Self.payloadElementIndex(payload)
            let foregroundRecovery = try Self.payloadForegroundRecovery(payload)
            if elementId == nil, elementIndex == nil, x != nil, y != nil, snapshotId == nil,
                snapshotStore.latest(app: app) == nil
            {
                if let failure = requireScreenRecording(permissions) { return failure }
                let snapshotResult = try await getAppState(app: app)
                if case .failed = snapshotResult { return snapshotResult }
            }
            return try await executeWriteAction(app: app, permissions: permissions) {
                try await clickElement(
                    app: app, elementId: elementId, elementIndex: elementIndex, snapshotId: snapshotId, x: x, y: y,
                    button: Self.payloadMouseButton(payload), clickCount: Self.payloadClickCount(payload),
                    foregroundRecovery: foregroundRecovery
                )
            }
        case "element.scroll":
            let elementId = Self.payloadString(payload, "elementId")
            let elementIndex = try Self.payloadElementIndex(payload)
            let snapshotId = Self.payloadString(payload, "snapshotId")
            guard let direction = Self.payloadString(payload, "direction") else { return Self.missingField("direction") }
            let target: ComputerUseElementTarget
            switch resolveElementTarget(app: app, elementId: elementId, elementIndex: elementIndex, snapshotId: snapshotId, commandName: "element.scroll") {
            case let .failure(failure): return .failed(failure)
            case let .success(value): target = value
            }
            let pages = Self.payloadNumber(payload, "pages") ?? 1
            return try await executeWriteAction(app: app, permissions: permissions) {
                let native = try await backend.scrollElement(app: app, target: target, direction: direction, pages: pages)
                var base: [String: JSONValue] = ["app": .string(app)]
                for (key, value) in Self.targetResult(target) { base[key] = value }
                base["direction"] = .string(direction)
                base["pages"] = .number(pages)
                return .succeeded(Self.merged(base, native, summary: "Scrolled \(Self.targetText(target))"))
            }
        case "element.set_value":
            let elementId = Self.payloadString(payload, "elementId")
            let elementIndex = try Self.payloadElementIndex(payload)
            let snapshotId = Self.payloadString(payload, "snapshotId")
            guard let value = Self.payloadString(payload, "value") else { return Self.missingField("value") }
            let target: ComputerUseElementTarget
            switch resolveElementTarget(app: app, elementId: elementId, elementIndex: elementIndex, snapshotId: snapshotId, commandName: "element.set_value") {
            case let .failure(failure): return .failed(failure)
            case let .success(resolved): target = resolved
            }
            return try await executeWriteAction(app: app, permissions: permissions) {
                let native = try await backend.setElementValue(app: app, target: target, value: value)
                var base: [String: JSONValue] = ["app": .string(app)]
                for (key, entry) in Self.targetResult(target) { base[key] = entry }
                return .succeeded(Self.merged(base, native, summary: "Set \(Self.targetText(target))"))
            }
        case "element.perform_action":
            let elementId = Self.payloadString(payload, "elementId")
            let elementIndex = try Self.payloadElementIndex(payload)
            let snapshotId = Self.payloadString(payload, "snapshotId")
            guard let action = Self.payloadString(payload, "action") else { return Self.missingField("action") }
            let target: ComputerUseElementTarget
            switch resolveElementTarget(app: app, elementId: elementId, elementIndex: elementIndex, snapshotId: snapshotId, commandName: "element.perform_action") {
            case let .failure(failure): return .failed(failure)
            case let .success(resolved): target = resolved
            }
            return try await executeWriteAction(app: app, permissions: permissions) {
                let native = try await backend.performElementAction(app: app, target: target, action: action)
                var base: [String: JSONValue] = ["app": .string(app)]
                for (key, entry) in Self.targetResult(target) { base[key] = entry }
                base["action"] = .string(action)
                return .succeeded(Self.merged(base, native, summary: "Performed \(action)"))
            }
        case "keyboard.type_text":
            guard let text = Self.payloadString(payload, "text") else { return Self.missingField("text") }
            let snapshotId = Self.payloadString(payload, "snapshotId")
            let foregroundRecovery = try Self.payloadForegroundRecovery(payload)
            return try await executeWriteAction(app: app, permissions: permissions) {
                let native = try await backend.typeText(app: app, snapshotId: snapshotId, text: text, foregroundRecovery: foregroundRecovery)
                return .succeeded(Self.merged(["app": .string(app)], native, summary: "Typed text"))
            }
        case "keyboard.press_key":
            guard let key = Self.payloadString(payload, "key") else { return Self.missingField("key") }
            let snapshotId = Self.payloadString(payload, "snapshotId")
            let foregroundRecovery = try Self.payloadForegroundRecovery(payload)
            return try await executeWriteAction(app: app, permissions: permissions) {
                var native = try await backend.pressKey(app: app, snapshotId: snapshotId, key: key, foregroundRecovery: foregroundRecovery)
                let normalizedKey = native["normalizedKey"]?.stringValue ?? key
                native.removeValue(forKey: "normalizedKey")
                return .succeeded(Self.merged(["app": .string(app), "key": .string(normalizedKey)], native, summary: "Pressed \(normalizedKey)"))
            }
        default:
            return .failure(.unsupportedCommand, "Unsupported command: \(command.kind)")
        }
    }
}
