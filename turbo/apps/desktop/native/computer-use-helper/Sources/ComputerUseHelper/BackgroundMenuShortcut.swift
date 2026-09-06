import AppKit
import ApplicationServices

struct BackgroundMenuShortcut {
    let window: AXUIElement
    let textElement: AXUIElement
    let selection: CFRange
    let isSafariWebContent: Bool
}

func backgroundMenuShortcut(
    _ parsed: ParsedKeyPress, target: WindowTarget, deadline: TimeInterval
) throws -> BackgroundMenuShortcut? {
    guard parsed.flags & Int(CGEventFlags.maskCommand.rawValue) != 0,
          currentFrontmostApplication()?.processIdentifier != target.pid else { return nil }
    if let web = try safariEditingShortcut(parsed, target: target, deadline: deadline) { return web }
    let app = applicationElement(forProcessIdentifier: target.pid)
    guard let focused = axElementValue(attribute(app, kAXFocusedUIElementAttribute as CFString)),
          [kAXTextAreaRole, kAXTextFieldRole].contains(role(focused) ?? ""),
          let selection = selectedTextRange(focused) else { return nil }
    let window = try keyboardAXWindow(target)
    let readDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    var ancestor: AXUIElement? = focused
    var foundWindow = false
    for _ in 0..<limits.maxDepth {
        try ensureKeyboardDeliveryDeadline(readDeadline)
        guard let element = ancestor else { break }
        // Safari editing commands have a separate window-scoped focus check.
        // Other web handlers retain their existing process-addressed events.
        if role(element) == "AXWebArea" { return nil }
        if CFEqual(element, window) { foundWindow = true; break }
        ancestor = axElementValue(attribute(element, kAXParentAttribute as CFString))
    }
    guard foundWindow else {
        throw HelperFailure(code: "window_unavailable", message: "The focused text control is outside the keyboard target window; no input was sent")
    }
    guard try backgroundMenuBindingMatches(parsed, app: app, deadline: readDeadline) else { return nil }
    return BackgroundMenuShortcut(window: window, textElement: focused, selection: selection, isSafariWebContent: false)
}

func backgroundMenuBindingMatches(_ parsed: ParsedKeyPress, app: AXUIElement, deadline: TimeInterval) throws -> Bool {
    guard let menu = axElementValue(attribute(app, kAXMenuBarAttribute as CFString)) else { return false }
    let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(parsed.keyCode), keyDown: true)
    event?.flags = CGEventFlags(rawValue: UInt64(parsed.flags))
    let character = event.flatMap { NSEvent(cgEvent: $0)?.charactersIgnoringModifiers }
    var pending = [menu]
    var visited = 0
    while let item = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(deadline)
        visited += 1
        guard visited <= 2_000 else {
            throw HelperFailure(code: "unsupported_command", message: "The app menu is too large to validate this shortcut; no input was sent")
        }
        if role(item) == kAXMenuItemRole {
            let key = attribute(item, kAXMenuItemCmdVirtualKeyAttribute as CFString) as? NSNumber
            let menuCharacter = stringValue(attribute(item, kAXMenuItemCmdCharAttribute as CFString))
            let characterMatches = character.map {
                !$0.isEmpty && menuCharacter?.caseInsensitiveCompare($0) == .orderedSame
            } ?? false
            if (key?.intValue == parsed.keyCode || (key == nil && characterMatches)),
               (attribute(item, kAXMenuItemCmdModifiersAttribute as CFString) as? NSNumber)?.intValue == menuModifierMask(parsed) {
                return true
            }
        }
        pending.append(contentsOf: attributeArray(item, kAXChildrenAttribute as CFString))
    }
    return false
}

func backgroundKeyboardTitlebarPoint(_ shortcut: BackgroundMenuShortcut, target: WindowTarget, deadline: TimeInterval) throws -> CGPoint {
    guard stringValue(attribute(shortcut.window, kAXSubroleAttribute as CFString)) == kAXStandardWindowSubrole,
          let close = axElementValue(attribute(shortcut.window, kAXCloseButtonAttribute as CFString)),
          let closeFrame = elementFrame(close),
          closeFrame.minY >= target.frame.minY,
          closeFrame.maxY < target.frame.minY + min(80, target.frame.height / 3) else {
        throw HelperFailure(code: "window_unavailable", message: "The keyboard target has no identifiable native titlebar; no shortcut was sent")
    }
    let app = applicationElement(forProcessIdentifier: target.pid)
    for fraction in [0.5, 0.75, 0.25] {
        try ensureKeyboardDeliveryDeadline(deadline)
        let point = CGPoint(x: target.frame.minX + target.frame.width * fraction, y: closeFrame.midY)
        var hit: AXUIElement?
        // Only empty window chrome is eligible. Never click a title, proxy icon,
        // toolbar button, or document control to acquire the native key window.
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { continue }
        if CFEqual(hit, shortcut.window) {
            return point
        }
        // Safari integrates its titlebar into a toolbar. A hit on the toolbar
        // itself is empty chrome; labels, address fields, and buttons are not.
        // AXShowMenu is its contextual menu, not a left-click action.
        if shortcut.isSafariWebContent, role(hit) == kAXToolbarRole,
           axElementsEqual(axElementValue(attribute(hit, kAXWindowAttribute as CFString)), shortcut.window),
           actionNames(hit).allSatisfy({ $0 == kAXShowMenuAction }) {
            return point
        }
    }
    throw HelperFailure(code: "window_unavailable", message: "No empty native titlebar point is available for keyboard preparation; no shortcut was sent")
}

private func keyboardWindowActivationEvent(target: WindowTarget, active: Bool) throws -> CGEvent {
    guard let event = NSEvent.otherEvent(
        with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 0,
        windowNumber: target.windowNumber, context: nil, subtype: active ? 1 : 2, data1: 0, data2: 0
    )?.cgEvent else {
        throw HelperFailure(code: "accessibility_unavailable", message: "Unable to prepare native keyboard activation events; no input was sent")
    }
    event.setWindowAddressingFields(windowNumber: target.windowNumber)
    return event
}

func performBackgroundMenuShortcut(
    _ shortcut: BackgroundMenuShortcut, parsed: ParsedKeyPress, target: WindowTarget, deadline: TimeInterval
) throws -> [String: Any] {
    let point = try backgroundKeyboardTitlebarPoint(shortcut, target: target, deadline: deadline)
    let activate = try keyboardWindowActivationEvent(target: target, active: true)
    let deactivate = try keyboardWindowActivationEvent(target: target, active: false)
    let app = applicationElement(forProcessIdentifier: target.pid)
    try ensureBackgroundKeyboardWindow(target, deadline: deadline)
    // Inactive AppKit windows route Command-Z directly to keyDown/noop instead
    // of their menu key equivalent. Establish the app-local key window without
    // activating the process in WindowServer or clicking inside its document.
    activate.postToPid(target.pid)
    defer {
        if currentFrontmostApplication()?.processIdentifier != target.pid {
            deactivate.postToPid(target.pid)
            usleep(50_000)
        }
    }
    usleep(30_000)
    let dispatcher = AddressedEventDispatcher(target: target)
    try ensureKeyboardDeliveryDeadline(deadline)
    try dispatcher.postMouse(.leftMouseDown, at: point, button: .left, clickState: 1, pressure: 1)
    usleep(30_000)
    try dispatcher.postMouse(.leftMouseUp, at: point, button: .left, clickState: 1, pressure: 0)
    usleep(50_000)
    try ensureKeyboardDeliveryDeadline(deadline)
    let focused = shortcut.isSafariWebContent
        ? try focusedSafariWebTextElement(window: shortcut.window, deadline: deadline)
        : axElementValue(attribute(app, kAXFocusedUIElementAttribute as CFString))
    guard axElementsEqual(focused, shortcut.textElement),
          axElementsEqual(axElementValue(attribute(app, kAXFocusedWindowAttribute as CFString)), shortcut.window),
          let selection = selectedTextRange(shortcut.textElement),
          selection.location == shortcut.selection.location, selection.length == shortcut.selection.length else {
        throw HelperFailure(code: "unsupported_command", message: "The focused text or selection changed during keyboard preparation; no shortcut was sent")
    }
    try ensureKeyboardDeliveryDeadline(deadline)
    // Keep the original key event and responder chain, including custom menu
    // bindings and AppKit's menu validation. AXEnabled can retain the inactive
    // menu's disabled value until key-equivalent processing updates the menu.
    try postParsedKeyPress(parsed, to: target)
    usleep(50_000)
    return ["normalizedKey": parsed.normalizedKey, "targetWindowId": target.windowNumber,
            "backgroundActivation": true]
}
