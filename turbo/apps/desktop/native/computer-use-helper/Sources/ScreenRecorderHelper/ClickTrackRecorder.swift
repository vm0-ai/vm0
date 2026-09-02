import CoreGraphics
import Foundation
import ScreenRecorderCore

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

/// Records where and when the user clicked, and where the pointer went, for
/// the whole session's duration.
///
/// The tap is listen-only and never modifies events. It is created at session
/// level rather than HID level because a HID-level listening tap requires the
/// separate Input Monitoring grant, whereas the session level rides the
/// Accessibility grant the app already holds.
///
/// Only mouse-down events are observed by the tap. Keystrokes are deliberately
/// not captured: recording characters the user types would make this a
/// keylogger, and nothing downstream needs them.
///
/// The pointer trail is sampled on a timer rather than through the tap.
/// Reading the pointer position needs no permission, so the trail survives a
/// refused tap, and a fixed rate bounds the track's size no matter how fast
/// the mouse reports; the tap would have to be throttled anyway.
final class ClickTrackRecorder: @unchecked Sendable {
    /// Enough for a camera to follow the pointer smoothly; more only adds bytes.
    private static let trailInterval = DispatchTimeInterval.milliseconds(33)

    private let lock = NSLock()
    private var clicks: [CapturedClick] = []
    private var samples: [CapturedPointerSample] = []
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var warnings: [String] = []
    private let trailQueue = DispatchQueue(label: "ai.okou.recorder.pointer-trail")
    private let trailPolicy = PointerTrailPolicy()
    private var trailTimer: DispatchSourceTimer?
    /// Where the captured region stands right now, for a source that moves.
    /// Asked at each click, so the click is projected through the geometry of
    /// its own moment rather than the recording's first. Set before `start`.
    var geometryProvider: (() -> CaptureGeometry?)?

    /// Starts observing clicks and sampling the pointer. Never throws: losing
    /// the click track must not cost the user their video, so a refused tap is
    /// reported as a warning on the finished recording instead.
    func start() {
        startPointerTrail()
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
        let timer = trailTimer
        tap = nil
        runLoopSource = nil
        trailTimer = nil
        lock.unlock()

        timer?.cancel()

        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
    }

    private func startPointerTrail() {
        let timer = DispatchSource.makeTimerSource(queue: trailQueue)
        timer.schedule(
            deadline: .now(),
            repeating: Self.trailInterval,
            leeway: .milliseconds(5)
        )
        timer.setEventHandler { [weak self] in
            self?.samplePointer()
        }
        timer.resume()
        lock.lock()
        trailTimer = timer
        lock.unlock()
    }

    /// Reads where the pointer is right now and keeps it if it moved.
    ///
    /// The timestamp is taken from the same clock `CGEvent.timestamp` and the
    /// captured frames use, so the sample lands on the recording's timeline
    /// exactly like a click does.
    private func samplePointer() {
        guard let location = CGEvent(source: nil)?.location else {
            return
        }
        let nanoseconds = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        lock.lock()
        let previous = samples.last
        lock.unlock()
        guard trailPolicy.shouldKeep(x: location.x, y: location.y, previous: previous) else {
            return
        }
        let sample = CapturedPointerSample(
            nanoseconds: nanoseconds,
            screenX: Double(location.x),
            screenY: Double(location.y),
            geometry: geometryProvider?()
        )
        lock.lock()
        samples.append(sample)
        lock.unlock()
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
            nanoseconds: event.timestamp,
            screenX: Double(location.x),
            screenY: Double(location.y),
            button: button,
            clickCount: Int(event.getIntegerValueField(.mouseEventClickState)),
            modifiers: modifierNames(for: event.flags),
            geometry: geometryProvider?()
        )
        lock.lock()
        clicks.append(click)
        lock.unlock()
    }

    /// Projects the captured clicks and pointer samples onto the recording's
    /// timeline and geometry.
    ///
    /// `projectClicks` and `projectPointerSamples` own the drop rules; this
    /// only renders the result as JSON. `pointerEvents` is the one stream a
    /// camera wants: clicks and moves together, in time order.
    func track(
        timeline: ClickTimeline,
        pauses: PauseTimeline,
        geometry: CaptureGeometry,
        outputSize: OutputSize
    ) -> (
        clicks: [[String: Any]],
        pointerEvents: [[String: Any]],
        droppedOutOfFrame: Int,
        warnings: [String]
    ) {
        lock.lock()
        let captured = clicks
        let capturedSamples = samples
        let capturedWarnings = warnings
        lock.unlock()

        let projection = projectClicks(
            captured,
            timeline: timeline,
            geometry: geometry,
            outputSize: outputSize
        )
        let trail = projectPointerSamples(
            capturedSamples,
            timeline: timeline,
            geometry: geometry,
            outputSize: outputSize
        )
        // Clicks and samples travel the same timeline as the frames: one made
        // during a pause is at a moment the video does not contain, and one
        // made after a pause would otherwise point past where it actually
        // happened.
        func mediaMs(_ offsetMs: Int) -> Int? {
            guard let seconds = pauses.mediaTime(forCaptureTime: Double(offsetMs) / 1000)
            else {
                return nil
            }
            return Int((seconds * 1000).rounded())
        }
        var described: [[String: Any]] = []
        var events: [(tMs: Int, order: Int, json: [String: Any])] = []
        for click in projection.clicks {
            guard let tMs = mediaMs(click.offsetMs) else {
                continue
            }
            described.append([
                "tMs": tMs,
                "button": click.button,
                "clickCount": click.clickCount,
                "modifiers": click.modifiers,
                "screen": ["x": click.point.screenX, "y": click.point.screenY],
                "frame": ["x": click.point.frameX, "y": click.point.frameY],
                "normalized": [
                    "x": click.point.normalizedX, "y": click.point.normalizedY,
                ],
            ])
            events.append((tMs, 0, pointerEvent(tMs: tMs, kind: "click", point: click.point)))
        }
        for sample in trail {
            guard let tMs = mediaMs(sample.offsetMs) else {
                continue
            }
            events.append((tMs, 1, pointerEvent(tMs: tMs, kind: "move", point: sample.point)))
        }
        // A click and a move at the same millisecond list the click first, so
        // a consumer reading the stream in order sees the click land where the
        // trail has just arrived.
        events.sort { left, right in
            left.tMs == right.tMs ? left.order < right.order : left.tMs < right.tMs
        }
        return (
            described,
            events.map { $0.json },
            projection.droppedOutOfFrame,
            capturedWarnings
        )
    }

    /// One entry of the pointer stream. Positions are rounded to a ten
    /// thousandth of the frame: a 4K frame is still resolved to a pixel, and
    /// the thirty-per-second trail stays a fraction of the video's size.
    private func pointerEvent(tMs: Int, kind: String, point: MappedClickPoint) -> [String: Any] {
        func rounded(_ value: Double) -> Double {
            return (value * 10_000).rounded() / 10_000
        }
        return [
            "tMs": tMs,
            "kind": kind,
            "frame": ["x": point.frameX, "y": point.frameY],
            "normalized": ["x": rounded(point.normalizedX), "y": rounded(point.normalizedY)],
        ]
    }
}
