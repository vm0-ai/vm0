import AppKit
import ApplicationServices

struct TextSelectionShortcut {
    let element: AXUIElement
    let window: AXUIElement
    let characterCount: Int
}

func standardSelectAllMenuItem(_ app: AXUIElement, parsed: ParsedKeyPress, deadline: TimeInterval) throws -> Bool {
    guard let menu = axElementValue(attribute(app, kAXMenuBarAttribute as CFString)) else { return false }
    var pending = [menu]
    var visited = 0
    while let element = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(deadline)
        visited += 1
        guard visited <= 2_000 else { return false }
        // Verify the app's actual binding. A custom Command-A command must keep
        // its keyboard path instead of acquiring text-selection semantics.
        let identifier = stringValue(attribute(element, kAXIdentifierAttribute as CFString))
        let title = stringValue(attribute(element, kAXTitleAttribute as CFString))
        if role(element) == kAXMenuItemRole,
           identifier == "SelectAll" || title == "Select All" {
            let key = attribute(element, kAXMenuItemCmdVirtualKeyAttribute as CFString) as? NSNumber
            let character = stringValue(attribute(element, kAXMenuItemCmdCharAttribute as CFString))
            let matchesKey = key?.intValue == parsed.keyCode || (key == nil && character?.lowercased() == "a")
            if matchesKey,
               (attribute(element, kAXMenuItemCmdModifiersAttribute as CFString) as? NSNumber)?.intValue == menuModifierMask(parsed) {
                return true
            }
        }
        pending.append(contentsOf: attributeArray(element, kAXChildrenAttribute as CFString))
    }
    return false
}

func textSelectionShortcut(_ parsed: ParsedKeyPress, target: WindowTarget, deadline: TimeInterval) throws -> TextSelectionShortcut? {
    guard parsed.keyCode == keyCodes["a"], menuModifierMask(parsed) == 0 else { return nil }
    let app = applicationElement(forProcessIdentifier: target.pid)
    guard let focused = axElementValue(attribute(app, kAXFocusedUIElementAttribute as CFString)),
          [kAXTextAreaRole, kAXTextFieldRole].contains(role(focused) ?? ""),
          attributeIsSettable(focused, kAXSelectedTextRangeAttribute as CFString) == true else { return nil }
    let readDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    let window = try keyboardAXWindow(target)
    var ancestor: AXUIElement? = focused
    var foundWindow = false
    for _ in 0..<limits.maxDepth {
        try ensureKeyboardDeliveryDeadline(readDeadline)
        guard let element = ancestor else { break }
        // Web content can override Command-A in JavaScript. Do not bypass that
        // application behavior even when its text control exposes AX selection.
        if role(element) == "AXWebArea" { return nil }
        if CFEqual(element, window) { foundWindow = true; break }
        ancestor = axElementValue(attribute(element, kAXParentAttribute as CFString))
    }
    guard foundWindow else {
        throw HelperFailure(code: "window_unavailable", message: "The focused text control is outside the keyboard target window; no input was sent")
    }
    guard try standardSelectAllMenuItem(app, parsed: parsed, deadline: readDeadline),
          let count = attribute(focused, kAXNumberOfCharactersAttribute as CFString) as? NSNumber,
          count.intValue >= 0, count.doubleValue == Double(count.intValue) else { return nil }
    return TextSelectionShortcut(element: focused, window: window, characterCount: count.intValue)
}

func selectedTextRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, kAXSelectedTextRangeAttribute as CFString),
          CFGetTypeID(raw as CFTypeRef) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cfRange else { return nil }
    var range = CFRange()
    return AXValueGetValue(value, .cfRange, &range) ? range : nil
}

func performTextSelection(_ selection: TextSelectionShortcut, target: WindowTarget, deadline: TimeInterval) throws -> [String: Any] {
    let app = applicationElement(forProcessIdentifier: target.pid)
    try ensureKeyboardDeliveryDeadline(deadline)
    guard axElementsEqual(axElementValue(attribute(app, kAXFocusedUIElementAttribute as CFString)), selection.element),
          axElementsEqual(axElementValue(attribute(selection.element, kAXWindowAttribute as CFString)), selection.window),
          (attribute(selection.element, kAXNumberOfCharactersAttribute as CFString) as? NSNumber)?.intValue == selection.characterCount else {
        throw HelperFailure(code: "unsupported_command", message: "The focused text changed before selection; no input was sent")
    }
    var range = CFRange(location: 0, length: selection.characterCount)
    guard let value = AXValueCreate(.cfRange, &range) else {
        throw HelperFailure(code: "accessibility_unavailable", message: "Unable to create the text selection range")
    }
    try ensureKeyboardDeliveryDeadline(deadline)
    try setAttribute(selection.element, kAXSelectedTextRangeAttribute as CFString, value)
    let settleDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 1)
    repeat {
        if let actual = selectedTextRange(selection.element), actual.location == 0, actual.length == selection.characterCount,
           (attribute(selection.element, kAXNumberOfCharactersAttribute as CFString) as? NSNumber)?.intValue == actual.length {
            return ["shortcutAction": "select_all", "targetWindowId": target.windowNumber,
                    "selectionLocation": actual.location, "selectionLength": actual.length]
        }
        usleep(50_000)
    } while ProcessInfo.processInfo.systemUptime < settleDeadline
    throw HelperFailure(code: "accessibility_unavailable", message: "The app did not confirm the text selection; no additional input was sent")
}
