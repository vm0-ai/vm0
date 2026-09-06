import AppKit
import ApplicationServices

// Keep the native AX identity, not a positional tree path or a title/URL that
// another tab can share. These references stay in the bounded runtime session.
struct SafariSnapshotTab {
    let window: AXUIElement
    let tab: AXUIElement
}

func safariWindowTabs(_ window: AXUIElement, deadline: TimeInterval) throws -> [AXUIElement] {
    var pending = [window]
    var seen = Set<CFHashCode>()
    var tabs: [AXUIElement] = []
    while let element = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(deadline)
        guard seen.insert(CFHash(element)).inserted else { continue }
        guard seen.count <= 2_000 else {
            throw HelperFailure(code: "unsupported_command", message: "The browser window is too large to validate its tab; no input was sent")
        }
        if role(element) == "AXWebArea" { continue }
        if stringValue(attribute(element, kAXSubroleAttribute as CFString)) == "AXTabButton" {
            tabs.append(element)
        } else {
            pending.append(contentsOf: attributeArray(element, kAXChildrenAttribute as CFString))
        }
    }
    return tabs
}

func captureSafariSnapshotTab(app: NSRunningApplication) throws -> SafariSnapshotTab? {
    guard app.bundleIdentifier == "com.apple.Safari" else { return nil }
    guard let target = resolveWindowTarget(app: app) ?? resolveWindowTarget(app: app, scope: .anySpace) else {
        throw windowTargetUnavailableFailure(appName: app.localizedName ?? "Safari", pid: app.processIdentifier)
    }
    let window = try keyboardAXWindow(target)
    let tabs = try safariWindowTabs(window, deadline: ProcessInfo.processInfo.systemUptime + 2)
    guard !tabs.isEmpty else { return nil }
    let selected = tabs.filter { numberValue(attribute($0, kAXValueAttribute as CFString)) == 1 }
    guard selected.count == 1, let tab = selected.first else {
        throw HelperFailure(code: "window_unavailable", message: "The selected browser tab is ambiguous; refresh app.state before sending input")
    }
    return SafariSnapshotTab(window: window, tab: tab)
}

func validateSafariSnapshotTab(_ snapshot: SafariSnapshotTab, target: WindowTarget, deadline: TimeInterval, selected: Bool) throws {
    let window = try keyboardAXWindow(target)
    let tabs = try safariWindowTabs(window, deadline: deadline)
    guard CFEqual(snapshot.window, window), tabs.contains(where: { CFEqual($0, snapshot.tab) }) else {
        throw HelperFailure(code: "unsupported_command", message: "The browser tab captured by this snapshot is no longer available; refresh app.state before sending input")
    }
    if selected {
        let active = tabs.filter { numberValue(attribute($0, kAXValueAttribute as CFString)) == 1 }
        guard active.count == 1, let tab = active.first, CFEqual(tab, snapshot.tab) else {
            throw HelperFailure(code: "window_unavailable", message: "The selected browser tab differs from the snapshot; no input was sent")
        }
    }
}

func ensureSnapshotKeyboardTab(_ target: WindowTarget, deadline: TimeInterval) throws {
    guard let snapshot = target.safariSnapshotTab else { return }
    try validateSafariSnapshotTab(snapshot, target: target, deadline: deadline, selected: true)
}

func prepareSnapshotKeyboardTab(_ target: WindowTarget, deadline: TimeInterval) throws {
    guard let snapshot = target.safariSnapshotTab else { return }
    try validateSafariSnapshotTab(snapshot, target: target, deadline: deadline, selected: false)
    if numberValue(attribute(snapshot.tab, kAXValueAttribute as CFString)) != 1 {
        try ensureKeyboardDeliveryDeadline(deadline)
        guard AXUIElementPerformAction(snapshot.tab, kAXPressAction as CFString) == .success else {
            throw HelperFailure(code: "window_unavailable", message: "Unable to select the browser tab captured by the snapshot; no input was sent")
        }
    }
    let settleDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    while numberValue(attribute(snapshot.tab, kAXValueAttribute as CFString)) != 1 {
        try ensureKeyboardDeliveryDeadline(settleDeadline)
        usleep(50_000)
    }
    try ensureSnapshotKeyboardTab(target, deadline: deadline)
}
