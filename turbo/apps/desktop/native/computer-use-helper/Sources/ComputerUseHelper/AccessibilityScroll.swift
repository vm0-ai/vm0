import ApplicationServices
import ComputerUseHelperCore
import Foundation

struct AccessibilityScrollRequest {
    let vertical: Bool
    let forward: Bool
    let pages: Double

    init(_ request: [String: Any]) throws {
        let direction = try requiredString(request, "direction")
        guard ["up", "down", "left", "right"].contains(direction) else {
            throw HelperFailure(code: "unsupported_command", message: "Invalid scroll direction: \(direction)")
        }
        vertical = direction == "up" || direction == "down"
        forward = direction == "down" || direction == "right"
        let value = request["pages"] ?? NSNumber(value: 1)
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue > 0
        else {
            throw HelperFailure(code: "unsupported_command", message: "Scroll pages must be a positive finite number")
        }
        pages = number.doubleValue
    }
}

func accessibilityScrollTarget(_ element: AXUIElement, vertical: Bool) throws -> (area: AXUIElement, bar: AXUIElement) {
    let name = vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute
    var target = element
    for _ in 0..<limits.maxDepth {
        if let bar = axElementValue(attribute(target, name as CFString)), role(bar) == kAXScrollBarRole {
            return (target, bar)
        }
        // A nested scroll area owns its own axes; do not scroll an unrelated ancestor.
        guard role(target) != kAXScrollAreaRole, role(target) != kAXWindowRole,
              let parent = axElementValue(attribute(target, kAXParentAttribute as CFString))
        else { break }
        target = parent
    }
    throw HelperFailure(
        code: "unsupported_command",
        message: "The target does not expose a \(vertical ? "vertical" : "horizontal") accessibility scroll bar"
    )
}

func accessibilityScrollPosition(_ bar: AXUIElement) throws -> Double {
    guard let value = numberValue(attribute(bar, kAXValueAttribute as CFString)),
          value.isFinite, (0...1).contains(value)
    else {
        throw HelperFailure(code: "accessibility_unavailable", message: "Cannot read the scroll bar position")
    }
    return value
}

func ensureScrollDeadline(_ deadline: TimeInterval) throws {
    guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw HelperFailure(code: "target_app_unresponsive", message: "Scroll command exceeded its time limit")
    }
}

func accessibilityPageButton(_ bar: AXUIElement, forward: Bool) -> AXUIElement? {
    let subrole = forward ? kAXIncrementPageSubrole : kAXDecrementPageSubrole
    return attributeArray(bar, kAXChildrenAttribute as CFString).first(where: {
        stringValue(attribute($0, kAXSubroleAttribute as CFString)) == subrole
    })
}

func pressAccessibilityPage(_ button: AXUIElement, deadline: TimeInterval) throws {
    try ensureScrollDeadline(deadline)
    let error = AXUIElementPerformAction(button, kAXPressAction as CFString)
    guard error == .success else {
        throw HelperFailure(
            code: error == .cannotComplete ? "target_app_unresponsive" : "accessibility_unavailable",
            message: "Unable to perform the scroll bar page action: \(error.rawValue)"
        )
    }
}

func changedAccessibilityScrollPosition(_ bar: AXUIElement, previous: Double, commandDeadline: TimeInterval) throws -> Double {
    let policy = AccessibilitySettlePolicy.postAction
    let deadline = min(commandDeadline, ProcessInfo.processInfo.systemUptime + policy.timeoutSeconds)
    var latest = previous
    var stablePasses = 0
    repeat {
        let value = try accessibilityScrollPosition(bar)
        stablePasses = value == latest ? stablePasses + 1 : 1
        latest = value
        if value != previous, stablePasses >= policy.requiredStablePasses { return value }
        usleep(policy.pollIntervalMicroseconds)
    } while ProcessInfo.processInfo.systemUptime < deadline
    try ensureScrollDeadline(commandDeadline)
    throw HelperFailure(code: "accessibility_unavailable", message: "The scroll action did not settle at a new position")
}

func performAccessibilityScroll(
    _ element: AXUIElement, request: AccessibilityScrollRequest, deadline: TimeInterval
) throws -> [String: Any] {
    let (area, bar) = try accessibilityScrollTarget(element, vertical: request.vertical)
    let initial = try accessibilityScrollPosition(bar)
    var position = initial
    var completed = 0.0
    var usedPageAction = false
    var usedScrollEvent = false
    let boundary = request.forward ? 1.0 : 0.0
    while completed < request.pages, position != boundary {
        try ensureScrollDeadline(deadline)
        let remaining = request.pages - completed
        let step = min(1, remaining)
        if step == 1, let button = accessibilityPageButton(bar, forward: request.forward) {
            try pressAccessibilityPage(button, deadline: deadline)
            usedPageAction = true
        } else {
            try scrollVisibleFraction(area, bar: bar, vertical: request.vertical, forward: request.forward, fraction: step, deadline: deadline)
            usedScrollEvent = true
        }
        let updated = try changedAccessibilityScrollPosition(bar, previous: position, commandDeadline: deadline)
        guard request.forward ? updated > position : updated < position else {
            throw HelperFailure(code: "accessibility_unavailable", message: "The scroll action moved in the wrong direction")
        }
        position = updated
        completed += step
    }
    let dispatchMode = usedScrollEvent
        ? (usedPageAction ? "mixed_native_scroll" : "background_scroll_event")
        : "accessibility_action"
    return ["scrollDispatchMode": dispatchMode, "scrollPositionBefore": initial, "scrollPositionAfter": position,
            "pagesCompleted": completed, "atBoundary": position == boundary]
}
