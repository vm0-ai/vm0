import CoreGraphics
import Foundation
import ScreenRecorderCore

struct CapturedClick {
    let ticks: UInt64
    let screenX: Double
    let screenY: Double
    let button: String
    let clickCount: Int
    let modifiers: [String]
}

private func buttonName(for type: CGEventType) -> String? {
    switch type {
    case .leftMouseDown:
        return "left"
    case .rightMouseDown:
        return "right"
    case .otherMouseDown:
        return "middle"
    default:
        return nil
    }
}

private func modifierNames(for flags: CGEventFlags) -> [String] {
    var names: [String] = []
    if flags.contains(.maskCommand) { names.append("command") }
    if flags.contains(.maskShift) { names.append("shift") }
    if flags.contains(.maskControl) { names.append("control") }
    if flags.contains(.maskAlternate) { names.append("option") }
    return names
}

private let clickTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon else {
        return Unmanaged.passUnretained(event)
    }
    let recorder = Unmanaged<ClickTrackRecorder>.fromOpaque(refcon)
        .takeUnretainedValue()
    recorder.handle(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

/// Records where and when the user clicked, for the whole session's duration.
///
/// The tap is listen-only and never modifies events. It is created at session
/// level rather than HID level because a HID-level listening tap requires the
/// separate Input Monitoring grant, whereas the session level rides the
/// Accessibility grant the app already holds.
///
/// Only mouse-down events are observed. Keystrokes are deliberately not
/// captured: recording characters the user types would make this a keylogger,
/// and nothing downstream needs them.
final class ClickTrackRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var clicks: [CapturedClick] = []
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var warnings: [String] = []

    /// Starts observing clicks. Never throws: losing the click track must not
    /// cost the user their video, so a refused tap is reported as a warning on
    /// the finished recording instead.
    func start() {
        let mask =
            (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)

        guard
            let eventTap = CGEvent.tapCreate(
                tap: .cgAnnotatedSessionEventTap,
                place: .tailAppendEventTap,
                options: .listenOnly,
                eventsOfInterest: CGEventMask(mask),
                callback: clickTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
        else {
            lock.lock()
            warnings.append(
                "Click tracking is unavailable; grant Accessibility access to Okou to record clicks."
            )
            lock.unlock()
            return
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        // CFRunLoopAddSource is thread safe, and the helper's main thread is
        // already running a run loop for ScreenCaptureKit.
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)

        lock.lock()
        tap = eventTap
        runLoopSource = source
        lock.unlock()
    }

    func stop() {
        lock.lock()
        let eventTap = tap
        let source = runLoopSource
        tap = nil
        runLoopSource = nil
        lock.unlock()

        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
    }

    /// Called on the run loop that owns the tap. Deliberately does no more than
    /// append: a slow tap callback gets the whole tap disabled by the system
    /// with `kCGEventTapDisabledByTimeout`.
    fileprivate func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let eventTap = tap
            lock.unlock()
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return
        }
        guard let button = buttonName(for: type) else {
            return
        }
        let location = event.location
        let click = CapturedClick(
            ticks: event.timestamp,
            screenX: Double(location.x),
            screenY: Double(location.y),
            button: button,
            clickCount: Int(event.getIntegerValueField(.mouseEventClickState)),
            modifiers: modifierNames(for: event.flags)
        )
        lock.lock()
        clicks.append(click)
        lock.unlock()
    }

    /// Projects the captured clicks onto the recording's timeline and geometry.
    ///
    /// Clicks outside the captured region are counted but not described: while
    /// recording one window, a click elsewhere happened in an application the
    /// user never agreed to record.
    func track(
        timeline: ClickTimeline,
        geometry: CaptureGeometry,
        outputSize: OutputSize
    ) -> (clicks: [[String: Any]], droppedOutOfFrame: Int, warnings: [String]) {
        lock.lock()
        let captured = clicks
        let capturedWarnings = warnings
        lock.unlock()

        var described: [[String: Any]] = []
        var dropped = 0
        for click in captured {
            guard
                let offsetMs = timeline.offsetMilliseconds(atTicks: click.ticks),
                let point = geometry.mapClick(
                    screenX: click.screenX,
                    screenY: click.screenY,
                    outputSize: outputSize
                )
            else {
                dropped += 1
                continue
            }
            described.append([
                "tMs": offsetMs,
                "button": click.button,
                "clickCount": click.clickCount,
                "modifiers": click.modifiers,
                "screen": ["x": point.screenX, "y": point.screenY],
                "frame": ["x": point.frameX, "y": point.frameY],
                "normalized": ["x": point.normalizedX, "y": point.normalizedY],
            ])
        }
        return (described, dropped, capturedWarnings)
    }
}
