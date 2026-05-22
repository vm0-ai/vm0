import AppKit
import ApplicationServices
import Darwin
import Foundation

struct HelperFailure: Error {
    let code: String
    let message: String
}

struct SnapshotLimits {
    let maxDepth = 32
    let maxNodes = 2_000
    let maxChildrenPerSource = 160
    let maxWindows = 8
    let maxActions = 12
}

struct ChildEntry {
    let element: AXUIElement
    let segment: String
}

let limits = SnapshotLimits()

func isRecord(_ value: Any) -> [String: Any]? {
    return value as? [String: Any]
}

func requiredString(_ request: [String: Any], _ key: String) throws -> String {
    guard let value = request[key] as? String else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return trimmed
}

func requiredNumber(_ request: [String: Any], _ key: String) throws -> Double {
    guard let value = request[key] as? NSNumber else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return value.doubleValue
}

func requiredInt(_ request: [String: Any], _ key: String) throws -> Int {
    guard let value = request[key] as? NSNumber else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return value.intValue
}

func optionalString(_ request: [String: Any], _ key: String) -> String? {
    guard let value = request[key] as? String else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func optionalInt(_ request: [String: Any], _ key: String, default defaultValue: Int) -> Int {
    return (request[key] as? NSNumber)?.intValue ?? defaultValue
}

func findRunningApp(named appName: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { app in
        !app.isTerminated
    }

    if let exact = apps.first(where: { app in
        app.localizedName == appName || app.bundleIdentifier == appName
    }) {
        return exact
    }

    let normalized = appName.lowercased()
    return apps.first { app in
        app.localizedName?.lowercased() == normalized ||
            app.bundleIdentifier?.lowercased() == normalized
    }
}

func resolveRunningApp(named appName: String) throws -> NSRunningApplication {
    guard let app = findRunningApp(named: appName) else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "App is not running: \(appName)"
        )
    }
    return app
}

func appElement(named appName: String) throws -> AXUIElement {
    let app = try resolveRunningApp(named: appName)
    return AXUIElementCreateApplication(app.processIdentifier)
}

func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name, &value)
    if error != .success {
        return nil
    }
    return value
}

func attributeArray(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
    guard let value = attribute(element, name) else {
        return []
    }
    if let elements = value as? [AXUIElement] {
        return elements
    }
    if let elements = value as? [Any] {
        return elements.compactMap { entry in
            axElementValue(entry)
        }
    }
    return []
}

func axElementValue(_ value: Any?) -> AXUIElement? {
    guard let value else {
        return nil
    }
    let cfValue = value as CFTypeRef
    if CFGetTypeID(cfValue) != AXUIElementGetTypeID() {
        return nil
    }
    return (value as! AXUIElement)
}

func axValueValue(_ value: Any?) -> AXValue? {
    guard let value else {
        return nil
    }
    let cfValue = value as CFTypeRef
    if CFGetTypeID(cfValue) != AXValueGetTypeID() {
        return nil
    }
    return (value as! AXValue)
}

func stringValue(_ value: Any?) -> String? {
    if let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if let number = value as? NSNumber {
        return number.stringValue
    }
    return nil
}

func boolValue(_ value: Any?) -> Bool? {
    return (value as? NSNumber)?.boolValue
}

func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    if let string = value as? String {
        return Double(string)
    }
    return nil
}

func pointValue(_ value: Any?) -> CGPoint? {
    guard let axValue = axValueValue(value), AXValueGetType(axValue) == .cgPoint else {
        return nil
    }
    var point = CGPoint.zero
    AXValueGetValue(axValue, .cgPoint, &point)
    return point
}

func sizeValue(_ value: Any?) -> CGSize? {
    guard let axValue = axValueValue(value), AXValueGetType(axValue) == .cgSize else {
        return nil
    }
    var size = CGSize.zero
    AXValueGetValue(axValue, .cgSize, &size)
    return size
}

func role(_ element: AXUIElement) -> String? {
    return stringValue(attribute(element, kAXRoleAttribute as CFString))
}

func bounds(_ element: AXUIElement) -> [String: Double]? {
    guard let position = pointValue(attribute(element, kAXPositionAttribute as CFString)),
          let size = sizeValue(attribute(element, kAXSizeAttribute as CFString))
    else {
        return nil
    }
    return [
        "x": Double(position.x),
        "y": Double(position.y),
        "width": Double(size.width),
        "height": Double(size.height),
    ]
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let error = AXUIElementCopyActionNames(element, &names)
    if error != .success {
        return []
    }
    return ((names as? [String]) ?? []).prefix(limits.maxActions).map { name in
        name
    }
}

func setAttribute(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) throws {
    let error = AXUIElementSetAttributeValue(element, name, value)
    if error != .success {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to set accessibility attribute \(name): \(error.rawValue)"
        )
    }
}

func bestEffortSetAttribute(_ element: AXUIElement, _ name: String, _ value: Bool) {
    _ = AXUIElementSetAttributeValue(element, name as CFString, NSNumber(value: value))
}

func enableBestEffortAccessibilityModes(_ element: AXUIElement) {
    bestEffortSetAttribute(element, "AXManualAccessibility", true)
    bestEffortSetAttribute(element, "AXEnhancedUserInterface", true)
}

func childFingerprint(_ element: AXUIElement) -> String {
    guard let bounds = bounds(element) else {
        return ""
    }
    let x = bounds["x"] ?? 0
    let y = bounds["y"] ?? 0
    let width = bounds["width"] ?? 0
    let height = bounds["height"] ?? 0
    let boundsText = "\(x),\(y),\(width),\(height)"
    return [
        role(element) ?? "",
        stringValue(attribute(element, kAXTitleAttribute as CFString)) ?? "",
        stringValue(attribute(element, kAXValueAttribute as CFString)) ?? "",
        boundsText,
    ].joined(separator: "|")
}

func prefixedChildren(
    _ element: AXUIElement,
    _ attributeName: CFString,
    _ prefix: String
) -> [ChildEntry] {
    return attributeArray(element, attributeName)
        .prefix(limits.maxChildrenPerSource)
        .enumerated()
        .map { index, child in
            ChildEntry(element: child, segment: "\(prefix)\(index)")
        }
}

func collectChildren(_ element: AXUIElement) -> [ChildEntry] {
    let candidates = prefixedChildren(element, kAXChildrenAttribute as CFString, "e") +
        prefixedChildren(element, "AXRows" as CFString, "r") +
        prefixedChildren(element, "AXContents" as CFString, "c") +
        prefixedChildren(element, "AXVisibleChildren" as CFString, "v")

    var seen = Set<String>()
    var children: [ChildEntry] = []
    for candidate in candidates {
        let fingerprint = childFingerprint(candidate.element)
        if !fingerprint.isEmpty {
            if seen.contains(fingerprint) {
                continue
            }
            seen.insert(fingerprint)
        }
        children.append(candidate)
    }
    return children
}

func markTruncated(_ reasons: inout [String], _ reason: String) {
    if !reasons.contains(reason) {
        reasons.append(reason)
    }
}

func describe(
    _ element: AXUIElement,
    id: String,
    depth: Int,
    nodeCount: inout Int,
    truncationReasons: inout [String]
) -> [String: Any]? {
    if nodeCount >= limits.maxNodes {
        markTruncated(&truncationReasons, "max_nodes")
        return nil
    }
    if depth > limits.maxDepth {
        markTruncated(&truncationReasons, "max_depth")
        return nil
    }
    nodeCount += 1

    var node: [String: Any] = ["id": id]
    if let role = role(element) {
        node["role"] = role
    }
    if let roleDescription = stringValue(attribute(element, kAXRoleDescriptionAttribute as CFString)) {
        node["roleDescription"] = roleDescription
    }
    if let name = stringValue(attribute(element, kAXTitleAttribute as CFString)) {
        node["name"] = name
    }
    if let value = stringValue(attribute(element, kAXValueAttribute as CFString)) {
        node["value"] = value
    }
    if let description = stringValue(attribute(element, kAXDescriptionAttribute as CFString)) {
        node["description"] = description
    }
    if let focused = boolValue(attribute(element, kAXFocusedAttribute as CFString)) {
        node["focused"] = focused
    }
    if let enabled = boolValue(attribute(element, kAXEnabledAttribute as CFString)) {
        node["enabled"] = enabled
    }
    let actions = actionNames(element)
    if !actions.isEmpty {
        node["actions"] = actions
    }
    if let bounds = bounds(element) {
        node["bounds"] = bounds
    }

    if depth >= limits.maxDepth {
        markTruncated(&truncationReasons, "max_depth")
        return node
    }

    let children = collectChildren(element).compactMap { child in
        describe(
            child.element,
            id: "\(id).\(child.segment)",
            depth: depth + 1,
            nodeCount: &nodeCount,
            truncationReasons: &truncationReasons
        )
    }
    if !children.isEmpty {
        node["children"] = children
    }
    return node
}

func resolveIndex(_ segment: Substring) throws -> Int {
    guard segment.count > 1,
          let index = Int(segment.dropFirst()),
          index >= 0
    else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Invalid element id segment: \(segment)"
        )
    }
    return index
}

func childForSegment(_ element: AXUIElement, _ segment: Substring) throws -> AXUIElement {
    let index = try resolveIndex(segment)
    let children: [AXUIElement]
    if segment.hasPrefix("e") {
        children = attributeArray(element, kAXChildrenAttribute as CFString)
    } else if segment.hasPrefix("r") {
        children = attributeArray(element, "AXRows" as CFString)
    } else if segment.hasPrefix("c") {
        children = attributeArray(element, "AXContents" as CFString)
    } else if segment.hasPrefix("v") {
        children = attributeArray(element, "AXVisibleChildren" as CFString)
    } else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Invalid element id segment: \(segment)"
        )
    }

    guard index < children.count else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Element not found: \(segment)"
        )
    }
    return children[index]
}

func resolveElement(appName: String, elementId: String) throws -> AXUIElement {
    let root = try appElement(named: appName)
    let parts = elementId.split(separator: ".")
    var current: AXUIElement?

    for part in parts {
        if part.hasPrefix("w") {
            let index = try resolveIndex(part)
            let windows = attributeArray(root, kAXWindowsAttribute as CFString)
            guard index < windows.count else {
                throw HelperFailure(
                    code: "accessibility_unavailable",
                    message: "Element not found: \(elementId)"
                )
            }
            current = windows[index]
        } else {
            guard let element = current else {
                throw HelperFailure(
                    code: "unsupported_command",
                    message: "Invalid element id: \(elementId)"
                )
            }
            current = try childForSegment(element, part)
        }
    }

    guard let resolved = current else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Element not found: \(elementId)"
        )
    }
    return resolved
}

func handleAppsList() -> [String: Any] {
    var names = Set<String>()
    for app in NSWorkspace.shared.runningApplications {
        if app.activationPolicy == .regular,
           let name = app.localizedName,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            names.insert(name)
        }
    }
    return ["apps": Array(names).sorted()]
}

func handleAppState(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let snapshotId = try requiredString(request, "snapshotId")

    guard let runningApp = findRunningApp(named: appName) else {
        return [
            "app": appName,
            "snapshotId": snapshotId,
            "elements": [],
            "nodeCount": 0,
            "truncated": false,
            "truncationReasons": [],
        ]
    }

    let root = AXUIElementCreateApplication(runningApp.processIdentifier)
    enableBestEffortAccessibilityModes(root)

    var nodeCount = 0
    var truncationReasons: [String] = []
    let windows = attributeArray(root, kAXWindowsAttribute as CFString)
        .prefix(limits.maxWindows)
        .enumerated()
        .compactMap { index, window in
            describe(
                window,
                id: "w\(index)",
                depth: 0,
                nodeCount: &nodeCount,
                truncationReasons: &truncationReasons
            )
        }

    return [
        "app": appName,
        "snapshotId": snapshotId,
        "elements": windows,
        "nodeCount": nodeCount,
        "truncated": !truncationReasons.isEmpty,
        "truncationReasons": truncationReasons,
    ]
}

func handleAppOpen(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", appName]
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to open \(appName)"
        )
    }
    return [:]
}

func handleElementClick(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let clickCount = max(1, min(optionalInt(request, "clickCount", default: 1), 3))
    let element = try resolveElement(appName: appName, elementId: elementId)
    for index in 0..<clickCount {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if error != .success {
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to press \(elementId): \(error.rawValue)"
            )
        }
        if index + 1 < clickCount {
            usleep(50_000)
        }
    }
    return [:]
}

func mouseEventConfig(button: String) throws -> (
    down: CGEventType,
    up: CGEventType,
    button: CGMouseButton
) {
    if button == "left" {
        return (.leftMouseDown, .leftMouseUp, .left)
    }
    if button == "right" {
        return (.rightMouseDown, .rightMouseUp, .right)
    }
    if button == "middle" {
        return (.otherMouseDown, .otherMouseUp, .center)
    }
    throw HelperFailure(
        code: "unsupported_command",
        message: "Unsupported mouse button: \(button)"
    )
}

func handleElementClickPoint(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let app = try resolveRunningApp(named: appName)
    let x = try requiredNumber(request, "x")
    let y = try requiredNumber(request, "y")
    let button = optionalString(request, "button") ?? "left"
    let clickCount = max(1, min(optionalInt(request, "clickCount", default: 1), 3))
    let config = try mouseEventConfig(button: button)
    let point = CGPoint(x: x, y: y)

    for index in 1...clickCount {
        for type in [config.down, config.up] {
            guard let event = CGEvent(
                mouseEventSource: nil,
                mouseType: type,
                mouseCursorPosition: point,
                mouseButton: config.button
            ) else {
                throw HelperFailure(
                    code: "accessibility_unavailable",
                    message: "Unable to create mouse event"
                )
            }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            event.postToPid(app.processIdentifier)
        }
        if index < clickCount {
            usleep(50_000)
        }
    }

    return [:]
}

func handleElementSetValue(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let value = try requiredString(request, "value")
    let element = try resolveElement(appName: appName, elementId: elementId)
    try setAttribute(element, kAXValueAttribute as CFString, value as CFString)
    return [:]
}

func handleElementPerformAction(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let action = try requiredString(request, "action")
    let element = try resolveElement(appName: appName, elementId: elementId)
    let error = AXUIElementPerformAction(element, action as CFString)
    if error != .success {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to perform \(action) on \(elementId): \(error.rawValue)"
        )
    }
    return [:]
}

func handleTypeText(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let inputText = try requiredString(request, "text")
    let root = try appElement(named: appName)
    guard let element = axElementValue(attribute(root, kAXFocusedUIElementAttribute as CFString)) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.type_text requires a focused editable text element in \(appName)"
        )
    }
    let role = role(element)
    let editableRoles = Set([
        "AXComboBox",
        "AXSearchField",
        "AXTextArea",
        "AXTextField",
        "AXTextView",
    ])
    guard let role, editableRoles.contains(role) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.type_text requires a focused editable text element in \(appName)"
        )
    }

    let currentValue = stringValue(attribute(element, kAXValueAttribute as CFString)) ?? ""
    try setAttribute(element, kAXValueAttribute as CFString, (currentValue + inputText) as CFString)
    var result: [String: Any] = ["role": role]
    if let description = stringValue(attribute(element, kAXDescriptionAttribute as CFString)) {
        result["description"] = description
    }
    return result
}

func postKey(pid: pid_t, keyCode: Int, keyDown: Bool, flags: Int) throws {
    guard let event = CGEvent(
        keyboardEventSource: nil,
        virtualKey: CGKeyCode(keyCode),
        keyDown: keyDown
    ) else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to create keyboard event"
        )
    }
    event.flags = CGEventFlags(rawValue: UInt64(flags))
    event.postToPid(pid)
}

func handlePressKey(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let app = try resolveRunningApp(named: appName)
    let keyCode = try requiredInt(request, "keyCode")
    let flags = try requiredInt(request, "flags")
    let modifierRecords = (request["modifiers"] as? [[String: Any]]) ?? []
    let modifiers = try modifierRecords.map { record -> (keyCode: Int, flag: Int) in
        guard let keyCode = record["keyCode"] as? NSNumber,
              let flag = record["flag"] as? NSNumber
        else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Invalid keyboard modifier payload"
            )
        }
        return (keyCode: keyCode.intValue, flag: flag.intValue)
    }

    var activeFlags = 0
    for modifier in modifiers {
        activeFlags |= modifier.flag
        try postKey(pid: app.processIdentifier, keyCode: modifier.keyCode, keyDown: true, flags: activeFlags)
    }
    try postKey(pid: app.processIdentifier, keyCode: keyCode, keyDown: true, flags: flags)
    try postKey(pid: app.processIdentifier, keyCode: keyCode, keyDown: false, flags: flags)
    for modifier in modifiers.reversed() {
        activeFlags &= ~modifier.flag
        try postKey(pid: app.processIdentifier, keyCode: modifier.keyCode, keyDown: false, flags: activeFlags)
    }
    return [:]
}

func handleScrollElement(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let direction = try requiredString(request, "direction")
    let pages = request["pages"] as? NSNumber
    let step = pages?.doubleValue ?? 1
    let axis = direction == "left" || direction == "right"
        ? "AXHorizontalScrollBar"
        : "AXVerticalScrollBar"
    let sign = direction == "up" || direction == "left" ? -1.0 : 1.0
    let element = try resolveElement(appName: appName, elementId: elementId)
    guard let scrollBar = attributeArray(element, kAXChildrenAttribute as CFString).first(where: { child in
        role(child) == axis
    }) else {
        return [:]
    }
    if let current = numberValue(attribute(scrollBar, kAXValueAttribute as CFString)) {
        try setAttribute(
            scrollBar,
            kAXValueAttribute as CFString,
            NSNumber(value: current + sign * step)
        )
    }
    return [:]
}

func handle(_ request: [String: Any]) throws -> [String: Any] {
    let kind = try requiredString(request, "kind")
    switch kind {
    case "apps.list":
        return handleAppsList()
    case "app.state":
        return try handleAppState(request)
    case "app.open":
        return try handleAppOpen(request)
    case "element.click":
        return try handleElementClick(request)
    case "element.click_point":
        return try handleElementClickPoint(request)
    case "element.set_value":
        return try handleElementSetValue(request)
    case "element.perform_action":
        return try handleElementPerformAction(request)
    case "keyboard.type_text":
        return try handleTypeText(request)
    case "keyboard.press_key":
        return try handlePressKey(request)
    case "element.scroll":
        return try handleScrollElement(request)
    default:
        throw HelperFailure(
            code: "unsupported_command",
            message: "Unsupported native Computer Use command: \(kind)"
        )
    }
}

func writeJSONObject(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func run() {
    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let parsed = try JSONSerialization.jsonObject(with: input, options: [])
        guard let request = isRecord(parsed) else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Native Computer Use helper requires a JSON object request"
            )
        }
        let result = try handle(request)
        try writeJSONObject([
            "status": "succeeded",
            "result": result,
        ])
    } catch let failure as HelperFailure {
        try? writeJSONObject([
            "status": "failed",
            "error": [
                "code": failure.code,
                "message": failure.message,
            ],
        ])
    } catch {
        try? writeJSONObject([
            "status": "failed",
            "error": [
                "code": "accessibility_unavailable",
                "message": String(describing: error),
            ],
        ])
    }
}

run()
