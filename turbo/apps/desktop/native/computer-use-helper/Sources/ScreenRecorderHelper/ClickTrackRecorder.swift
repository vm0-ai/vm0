import ApplicationServices
import CoreGraphics
import Foundation
import ScreenRecorderCore

/// Roles worth walking up to from whatever leaf a click landed on. A click on
/// the placeholder text of a field belongs to the field; a click on a button's
/// icon belongs to the button.
private let targetRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem",
    "AXCheckBox", "AXRadioButton", "AXLink", "AXTab", "AXSlider",
    "AXDisclosureTriangle", "AXCell", "AXRow", "AXIncrementor", "AXColorWell",
]

private func attributeValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func rect(of element: AXUIElement) -> CGRect? {
    guard
        let positionValue = attributeValue(element, kAXPositionAttribute),
        let sizeValue = attributeValue(element, kAXSizeAttribute),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else {
        return nil
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

/// The UI element under a screen point, described by role and frame only.
///
/// Walks up from the leaf that was hit to the nearest control-like ancestor,
/// so a click on a field's placeholder reports the field. Reads nothing else:
/// no titles, no values, no descriptions, so a text field's contents never
/// reach the track.
private func elementAt(_ point: CGPoint) -> CapturedElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var hit: AXUIElement?
    guard
        AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
        let hit
    else {
        return nil
    }
    var element = hit
    var role = attributeValue(element, kAXRoleAttribute) as? String ?? ""
    var depth = 0
    while !targetRoles.contains(role), depth < 8 {
        guard
            let parent = attributeValue(element, kAXParentAttribute),
            CFGetTypeID(parent) == AXUIElementGetTypeID()
        else {
            break
        }
        let parentElement = parent as! AXUIElement
        let parentRole = attributeValue(parentElement, kAXRoleAttribute) as? String ?? ""
        if parentRole == "AXWindow" || parentRole == "AXApplication" || parentRole == "AXWebArea" {
            break
        }
        element = parentElement
        role = parentRole
        depth += 1
    }
    if !targetRoles.contains(role) {
        element = hit
        role = attributeValue(hit, kAXRoleAttribute) as? String ?? ""
    }
    guard !role.isEmpty, let frame = rect(of: element) else {
        return nil
    }
    return CapturedElement(
        role: role,
        subrole: attributeValue(element, kAXSubroleAttribute) as? String,
        screenX: Double(frame.origin.x),
        screenY: Double(frame.origin.y),
        screenWidth: Double(frame.width),
        screenHeight: Double(frame.height)
    )
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

private let keyTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon else {
        return Unmanaged.passUnretained(event)
    }
    let recorder = Unmanaged<ClickTrackRecorder>.fromOpaque(refcon)
        .takeUnretainedValue()
    recorder.handleKey(type: type, event: event)
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
/// The click tap observes mouse-down events only. A second, separate tap
/// observes key-down events and keeps nothing but their timestamps: a camera
/// needs to know *when* the user was typing so it can stay on the field, and
/// nothing downstream needs to know *what* was typed. Key codes, characters and
/// modifier flags are never read, so the track cannot become a keylogger. The
/// two taps are separate so a refused keyboard tap cannot cost the click track.
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
    private var keyDowns: [UInt64] = []
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var keyTap: CFMachPort?
    private var keyRunLoopSource: CFRunLoopSource?
    private var warnings: [String] = []
    private let trailQueue = DispatchQueue(label: "ai.okou.recorder.pointer-trail")
    private let trailPolicy = PointerTrailPolicy()
    private var trailTimer: DispatchSourceTimer?
    /// Where the captured region stands right now, for a source that moves.
    /// Asked at each click, so the click is projected through the geometry of
    /// its own moment rather than the recording's first. Set before `start`.
    var geometryProvider: (() -> CaptureGeometry?)?
    /// Where the content sits in the frame right now; see `ContentMapping`.
    var mappingProvider: (() -> ContentMapping?)?
    private let elementQueue = DispatchQueue(label: "ai.okou.recorder.click-elements")
    private var elements: [Int: CapturedElement] = [:]

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

        startKeyTiming()
    }

    /// Observes when keys go down, and nothing else about them.
    private func startKeyTiming() {
        guard
            let eventTap = CGEvent.tapCreate(
                tap: .cgAnnotatedSessionEventTap,
                place: .tailAppendEventTap,
                options: .listenOnly,
                eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
                callback: keyTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
        else {
            lock.lock()
            warnings.append(
                "Typing timing is unavailable; grant Accessibility access to Okou to record when you type."
            )
            lock.unlock()
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)

        lock.lock()
        keyTap = eventTap
        keyRunLoopSource = source
        lock.unlock()
    }

    func stop() {
        lock.lock()
        let eventTap = tap
        let source = runLoopSource
        let keyEventTap = keyTap
        let keySource = keyRunLoopSource
        let timer = trailTimer
        tap = nil
        runLoopSource = nil
        keyTap = nil
        keyRunLoopSource = nil
        trailTimer = nil
        lock.unlock()

        timer?.cancel()

        for eventTap in [eventTap, keyEventTap].compactMap({ $0 }) {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        for source in [source, keySource].compactMap({ $0 }) {
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
            geometry: geometryProvider?(),
            mapping: mappingProvider?()
        )
        lock.lock()
        samples.append(sample)
        lock.unlock()
    }

    /// Called on the run loop that owns the keyboard tap. Reads the timestamp
    /// and nothing else from the event.
    fileprivate func handleKey(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let eventTap = keyTap
            lock.unlock()
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return
        }
        guard type == .keyDown else {
            return
        }
        let nanoseconds = event.timestamp
        lock.lock()
        keyDowns.append(nanoseconds)
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
            geometry: geometryProvider?(),
            mapping: mappingProvider?()
        )
        lock.lock()
        clicks.append(click)
        let index = clicks.count - 1
        lock.unlock()
        // The element lookup talks to the clicked application and can take a
        // while; the tap callback must stay instant, so it happens elsewhere.
        elementQueue.async { [weak self] in
            guard let self, let element = elementAt(location) else {
                return
            }
            self.lock.lock()
            self.elements[index] = element
            self.lock.unlock()
        }
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
        typingBursts: [[String: Any]],
        droppedOutOfFrame: Int,
        warnings: [String]
    ) {
        // Let element lookups still in flight finish; each is bounded by the
        // accessibility messaging timeout, so this cannot hang the recording.
        elementQueue.sync {}
        lock.lock()
        let captured = clicks.enumerated().map { index, click in
            click.withElement(elements[index])
        }
        let capturedSamples = samples
        let capturedKeyDowns = keyDowns
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
            var entry: [String: Any] = [
                "tMs": tMs,
                "button": click.button,
                "clickCount": click.clickCount,
                "modifiers": click.modifiers,
                "screen": ["x": click.point.screenX, "y": click.point.screenY],
                "frame": ["x": click.point.frameX, "y": click.point.frameY],
                "normalized": [
                    "x": click.point.normalizedX, "y": click.point.normalizedY,
                ],
            ]
            var event = pointerEvent(tMs: tMs, kind: "click", point: click.point)
            if let element = click.element.map({ describe($0, outputSize: outputSize) }) {
                entry["element"] = element
                event["element"] = element
            }
            described.append(entry)
            events.append((tMs, 0, event))
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
        // Key-downs before the first frame or inside a pause are moments the
        // video does not contain, exactly like clicks there.
        let keyOffsets = capturedKeyDowns.compactMap { nanoseconds -> Int? in
            guard let offsetMs = timeline.offsetMilliseconds(atNanoseconds: nanoseconds) else {
                return nil
            }
            return mediaMs(offsetMs)
        }
        let bursts: [[String: Any]] = typingBursts(fromKeyDownOffsetsMs: keyOffsets).map { burst in
            ["startMs": burst.startMs, "endMs": burst.endMs]
        }
        return (
            described,
            events.map { $0.json },
            bursts,
            projection.droppedOutOfFrame,
            capturedWarnings
        )
    }

    /// The element a click landed on, in frame pixels and frame fractions.
    private func describe(_ element: ProjectedElement, outputSize: OutputSize) -> [String: Any] {
        var described: [String: Any] = [
            "role": element.role,
            "frame": [
                "x": element.frameX, "y": element.frameY,
                "width": element.frameWidth, "height": element.frameHeight,
            ],
            "normalized": [
                "x": Double(element.frameX) / Double(outputSize.width),
                "y": Double(element.frameY) / Double(outputSize.height),
                "width": Double(element.frameWidth) / Double(outputSize.width),
                "height": Double(element.frameHeight) / Double(outputSize.height),
            ],
        ]
        if let subrole = element.subrole {
            described["subrole"] = subrole
        }
        return described
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
