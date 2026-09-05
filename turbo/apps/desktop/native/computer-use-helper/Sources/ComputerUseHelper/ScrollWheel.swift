import ApplicationServices
import Foundation

func scrollWindowTarget(_ area: AXUIElement) throws -> WindowTarget {
    guard let window = axElementValue(attribute(area, kAXWindowAttribute as CFString)),
          let frame = elementFrame(window)
    else {
        throw HelperFailure(code: "window_unavailable", message: "Cannot identify the scroll area's window")
    }
    var pid: pid_t = 0
    guard AXUIElementGetPid(area, &pid) == .success else {
        throw HelperFailure(code: "window_unavailable", message: "Cannot identify the scroll area's process")
    }
    let matches = cgWindowCandidates(pid: pid).filter { rectDistance($0.frame, frame) < 4 }
    guard matches.count == 1, let candidate = matches.first else {
        throw HelperFailure(code: "window_unavailable", message: "Cannot uniquely address the scroll area's window")
    }
    return WindowTarget(
        pid: pid, windowNumber: candidate.windowNumber, title: candidate.title,
        frame: candidate.frame, isOnScreen: candidate.isOnScreen,
        currentSpaceId: candidate.currentSpaceId, spaceIds: candidate.spaceIds
    )
}

func scrollVisibleFraction(
    _ area: AXUIElement, bar: AXUIElement, vertical: Bool, forward: Bool, fraction: Double, deadline: TimeInterval
) throws {
    let target = try scrollWindowTarget(area)
    guard let frame = elementFrame(area), let barFrame = elementFrame(bar) else {
        throw HelperFailure(code: "accessibility_unavailable", message: "Cannot measure the scroll area's visible bounds")
    }
    let viewport = frame.intersection(target.frame)
    // AX has only whole-page actions. Fractional pages use the visible extent
    // in screen points, which is also the unit consumed by a pixel wheel event.
    let extent = vertical ? viewport.height : viewport.width
    guard !viewport.isNull, viewport.width > 2, viewport.height > 2, extent.isFinite,
          let pixels = Int32(exactly: max(1, (Double(extent) * fraction).rounded()))
    else {
        throw HelperFailure(code: "unsupported_command", message: "Scroll distance is outside the supported range")
    }
    let delta = forward ? -pixels : pixels
    // A wheel over the content center can be consumed by a nested scroll view.
    // Address this area's scrollbar rail, constrained to its visible viewport
    // because WebKit can report a scrollbar frame beyond the viewport edge.
    let point = vertical
        ? CGPoint(x: min(max(barFrame.midX, viewport.minX + 1), viewport.maxX - 1), y: viewport.midY)
        : CGPoint(x: viewport.midX, y: min(max(barFrame.midY, viewport.minY + 1), viewport.maxY - 1))
    try ensureScrollDeadline(deadline)
    try AddressedEventDispatcher(target: target).postScroll(
        at: point, vertical: vertical ? delta : 0, horizontal: vertical ? 0 : delta
    )
}

extension AddressedEventDispatcher {
    func postScroll(at point: CGPoint, vertical: Int32, horizontal: Int32) throws {
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
            wheel1: vertical, wheel2: horizontal, wheel3: 0
        ) else {
            throw HelperFailure(code: "accessibility_unavailable", message: "Unable to create a scroll event")
        }
        event.location = point
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowNumber))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.windowNumber))
        event.setWindowAddressingFields(windowNumber: target.windowNumber)
        let local = windowLocalPoint(fromScreenPoint: point, windowFrame: target.frame)
        let quartz = quartzWindowPoint(fromWindowLocal: local, windowHeight: target.frame.height)
        guard BackgroundWindowLocalEvent.setPoint(quartz, on: event) else {
            throw HelperFailure(code: "accessibility_unavailable", message: "Unable to address the scroll event to its window")
        }
        // Address the process and window without a global wheel event or a
        // synthetic activation click that could change the document selection.
        event.postToPid(target.pid)
    }
}
