import AppKit
import ApplicationServices

func focusedSafariWebTextElement(window: AXUIElement, deadline: TimeInterval) throws -> AXUIElement? {
    let readDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    var pending = [(element: window, inWebContent: false)]
    var seen = Set<CFHashCode>()
    var focused: AXUIElement?
    while let item = pending.popLast() {
        try ensureKeyboardDeliveryDeadline(readDeadline)
        guard seen.insert(CFHash(item.element)).inserted else { continue }
        guard seen.count <= 2_000 else {
            throw HelperFailure(code: "unsupported_command", message: "The browser window is too large to validate keyboard focus; no input was sent")
        }
        let elementRole = role(item.element)
        let inWeb = item.inWebContent || elementRole == "AXWebArea"
        if inWeb, [kAXTextAreaRole, kAXTextFieldRole].contains(elementRole ?? ""),
           boolValue(attribute(item.element, kAXFocusedAttribute as CFString)) == true {
            guard focused == nil else {
                throw HelperFailure(code: "unsupported_command", message: "The browser window has ambiguous text focus; no input was sent")
            }
            focused = item.element
        }
        pending.append(contentsOf: traversalChildCandidates(item.element).map { ($0.element, inWeb) })
    }
    return focused
}

func safariEditingShortcut(_ parsed: ParsedKeyPress, target: WindowTarget, deadline: TimeInterval) throws -> BackgroundMenuShortcut? {
    guard NSRunningApplication(processIdentifier: target.pid)?.bundleIdentifier == "com.apple.Safari",
          ["a", "c", "x", "v", "z"].contains(where: { keyCodes[$0] == parsed.keyCode }) else { return nil }
    let window = try keyboardAXWindow(target)
    guard let focused = try focusedSafariWebTextElement(window: window, deadline: deadline) else { return nil }
    let app = applicationElement(forProcessIdentifier: target.pid)
    let readDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    guard try backgroundMenuBindingMatches(parsed, app: app, deadline: readDeadline) else { return nil }
    guard let selection = selectedTextRange(focused) else {
        throw HelperFailure(code: "window_unavailable", message: "The browser text selection cannot be validated; no input was sent")
    }
    // Keep the original key event so keydown/clipboard handlers can override
    // editing and selection normally. Direct menu or AX selection actions
    // would bypass those handlers, including a custom Command-A binding.
    return BackgroundMenuShortcut(window: window, textElement: focused, selection: selection, isSafariWebContent: true)
}
