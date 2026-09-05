import AppKit
import ApplicationServices

func currentFrontmostApplication() -> NSRunningApplication? {
    // NSWorkspace can retain a stale frontmost application in the long-lived
    // stdio helper. Query the system's current focus instead of that cache.
    let system = AXUIElementCreateSystemWide()
    configureAccessibilityMessagingTimeout(system)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &focused) == .success,
          let element = axElementValue(focused) else { return nil }
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return nil }
    return NSRunningApplication(processIdentifier: pid)
}

// Menu shortcuts use a different modifier mask from CGEvent. In particular,
// Command is implicit unless the NoCommand bit is present.
func menuModifierMask(_ parsed: ParsedKeyPress) -> Int {
    var mask = parsed.flags & Int(CGEventFlags.maskCommand.rawValue) == 0 ? 8 : 0
    if parsed.flags & Int(CGEventFlags.maskShift.rawValue) != 0 { mask |= 1 }
    if parsed.flags & Int(CGEventFlags.maskAlternate.rawValue) != 0 { mask |= 2 }
    if parsed.flags & Int(CGEventFlags.maskControl.rawValue) != 0 { mask |= 4 }
    return mask
}

func ensureKeyboardDeliveryDeadline(_ deadline: TimeInterval) throws {
    guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw HelperFailure(code: "target_app_unresponsive", message: "Keyboard preparation exceeded its time limit; no input was sent")
    }
}

func keyboardAXWindow(_ target: WindowTarget) throws -> AXUIElement {
    let app = applicationElement(forProcessIdentifier: target.pid)
    let candidates = attributeArray(app, kAXWindowsAttribute as CFString).filter {
        elementFrame($0).map { rectDistance($0, target.frame) < 4 } == true
    }
    guard candidates.count == 1, let window = candidates.first else {
        throw HelperFailure(code: "window_unavailable", message: "Unable to identify the keyboard target window unambiguously; no input was sent")
    }
    return window
}

struct SafariCloseTabTarget {
    let tab: AXUIElement
    let parent: AXUIElement
    let action: String
    let countBefore: Int
}

func safariCloseTabTarget(_ parsed: ParsedKeyPress, target: WindowTarget, deadline: TimeInterval) throws -> SafariCloseTabTarget? {
    guard NSRunningApplication(processIdentifier: target.pid)?.bundleIdentifier == "com.apple.Safari",
          parsed.keyCode == keyCodes["w"], menuModifierMask(parsed) == 0 else { return nil }
    let app = applicationElement(forProcessIdentifier: target.pid)
    guard let menu = axElementValue(attribute(app, kAXMenuBarAttribute as CFString)) else { return nil }
    let modifiers = menuModifierMask(parsed)
    let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(parsed.keyCode), keyDown: true)
    event?.flags = CGEventFlags(rawValue: UInt64(parsed.flags))
    let character = event.flatMap { NSEvent(cgEvent: $0)?.charactersIgnoringModifiers }
    var pending = [menu]
    var visited = 0
    var closesTab = false
    let readDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    while let element = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(readDeadline)
        visited += 1
        guard visited <= 2_000 else {
            throw HelperFailure(code: "unsupported_command", message: "The app menu is too large to validate this shortcut; no input was sent")
        }
        // Safari exposes the standard Command-W equivalent as CloseWindow
        // while inactive, although it closes one tab in a tabbed window.
        if ["CloseTab", "CloseWindow"].contains(stringValue(attribute(element, kAXIdentifierAttribute as CFString)) ?? "") {
            let key = attribute(element, kAXMenuItemCmdVirtualKeyAttribute as CFString) as? NSNumber
            let menuCharacter = stringValue(attribute(element, kAXMenuItemCmdCharAttribute as CFString))
            let characterMatches = character.map { value in
                !value.isEmpty && menuCharacter?.caseInsensitiveCompare(value) == .orderedSame
            } ?? false
            closesTab = (key?.intValue == parsed.keyCode || (key == nil && characterMatches))
                && (attribute(element, kAXMenuItemCmdModifiersAttribute as CFString) as? NSNumber)?.intValue == modifiers
            if closesTab { break }
        }
        pending.append(contentsOf: attributeArray(element, kAXChildrenAttribute as CFString))
        guard !accessibilityReadContextStorage.hasTimedOut() else {
            throw HelperFailure(code: "target_app_unresponsive", message: "The app did not respond while checking its shortcut; no input was sent")
        }
    }
    guard closesTab else { return nil }

    // Safari disables its menu equivalent while inactive but exposes the same
    // operation on the selected native tab. Do not click to acquire focus: that
    // would change the page's selection or activate unrelated content.
    pending = [try keyboardAXWindow(target)]
    visited = 0
    var selected: [AXUIElement] = []
    while let element = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(readDeadline)
        visited += 1
        guard visited <= 2_000 else { return nil }
        if role(element) == "AXWebArea" { continue }
        if stringValue(attribute(element, kAXSubroleAttribute as CFString)) == "AXTabButton",
           numberValue(attribute(element, kAXValueAttribute as CFString)) == 1 {
            selected.append(element)
        }
        pending.append(contentsOf: attributeArray(element, kAXChildrenAttribute as CFString))
    }
    guard selected.count == 1, let tab = selected.first,
          let parent = axElementValue(attribute(tab, kAXParentAttribute as CFString)),
          let action = actionNames(tab).first(where: { $0.hasPrefix("Name:close tab\n") }) else { return nil }
    return SafariCloseTabTarget(tab: tab, parent: parent, action: action, countBefore: attributeArray(parent, kAXChildrenAttribute as CFString).count)
}

func performSafariCloseTab(_ close: SafariCloseTabTarget, target: WindowTarget, deadline: TimeInterval) throws -> [String: Any] {
    try ensureKeyboardDeliveryDeadline(deadline)
    guard numberValue(attribute(close.tab, kAXValueAttribute as CFString)) == 1 else {
        throw HelperFailure(code: "unsupported_command", message: "The selected Safari tab changed before the shortcut; no input was sent")
    }
    let status = AXUIElementPerformAction(close.tab, close.action as CFString)
    guard status == .success else {
        throw HelperFailure(code: "accessibility_unavailable", message: "Unable to close the selected Safari tab: \(status.rawValue)")
    }
    let settleDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 1.5)
    repeat {
        let tabs = attributeArray(close.parent, kAXChildrenAttribute as CFString)
        if !tabs.contains(where: { CFEqual($0, close.tab) }) {
            return ["shortcutAction": "close_tab", "targetWindowId": target.windowNumber,
                    "tabCountBefore": close.countBefore, "tabCountAfter": tabs.count]
        }
        usleep(50_000)
    } while ProcessInfo.processInfo.systemUptime < settleDeadline
    throw HelperFailure(code: "accessibility_unavailable", message: "The selected Safari tab did not close; no additional input was sent")
}

func prepareForegroundKeyboardWindow(_ target: WindowTarget, deadline: TimeInterval) throws {
    try ensureKeyboardDeliveryDeadline(deadline)
    let app = applicationElement(forProcessIdentifier: target.pid)
    let window = try keyboardAXWindow(target)
    if !axElementsEqual(axElementValue(attribute(app, kAXFocusedWindowAttribute as CFString)), window) {
        try ensureKeyboardDeliveryDeadline(deadline)
        let status = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        guard status == .success else {
            throw HelperFailure(code: "window_unavailable", message: "Unable to focus the keyboard target window; no input was sent")
        }
    }
    let focusDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    repeat {
        try ensureKeyboardDeliveryDeadline(focusDeadline)
        if currentFrontmostApplication()?.processIdentifier == target.pid,
           axElementsEqual(axElementValue(attribute(app, kAXFocusedWindowAttribute as CFString)), window) {
            return
        }
        usleep(50_000)
    } while true
}
