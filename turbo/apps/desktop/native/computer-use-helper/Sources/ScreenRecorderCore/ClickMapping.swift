import Foundation

/// A click expressed in every coordinate space the downstream editor needs.
///
/// All three are reported because they answer different questions: `screen` is
/// the raw fact, `frame` can be drawn straight onto the encoded video, and
/// `normalized` survives the video being transcoded or resized later.
public struct MappedClickPoint: Equatable, Sendable {
    public let screenX: Double
    public let screenY: Double
    public let frameX: Int
    public let frameY: Int
    public let normalizedX: Double
    public let normalizedY: Double

    public init(
        screenX: Double,
        screenY: Double,
        frameX: Int,
        frameY: Int,
        normalizedX: Double,
        normalizedY: Double
    ) {
        self.screenX = screenX
        self.screenY = screenY
        self.frameX = frameX
        self.frameY = frameY
        self.normalizedX = normalizedX
        self.normalizedY = normalizedY
    }
}

extension CaptureGeometry {
    /// Maps a global screen point into the encoded frame.
    ///
    /// Returns `nil` when the click landed outside the captured region. Those
    /// clicks are dropped rather than clamped: while recording a single window,
    /// a click elsewhere happened in an application the user never agreed to
    /// record, so its position is not ours to keep.
    ///
    /// Both `CGEvent` locations and `CaptureGeometry` use a top-left origin, so
    /// no vertical flip belongs here. Callers reading positions from `NSEvent`,
    /// which has a bottom-left origin, must convert before calling.
    public func mapClick(
        screenX: Double,
        screenY: Double,
        outputSize: OutputSize
    ) -> MappedClickPoint? {
        guard widthPoints > 0, heightPoints > 0 else {
            return nil
        }
        let relativeX = screenX - originX
        let relativeY = screenY - originY
        guard
            relativeX >= 0, relativeX < widthPoints,
            relativeY >= 0, relativeY < heightPoints
        else {
            return nil
        }
        let normalizedX = relativeX / widthPoints
        let normalizedY = relativeY / heightPoints
        return MappedClickPoint(
            screenX: screenX,
            screenY: screenY,
            frameX: Int((normalizedX * Double(outputSize.width)).rounded(.down)),
            frameY: Int((normalizedY * Double(outputSize.height)).rounded(.down)),
            normalizedX: normalizedX,
            normalizedY: normalizedY
        )
    }
}

/// One observed click, in the plain values the tap captured.
///
/// Kept free of CoreGraphics types so the projection below can be exercised
/// without a capture device or an event tap.
public struct CapturedClick: Equatable, Sendable {
    /// `CGEvent.timestamp`: nanoseconds since boot on the host clock.
    public let nanoseconds: UInt64
    public let screenX: Double
    public let screenY: Double
    public let button: String
    public let clickCount: Int
    public let modifiers: [String]
    /// Where the captured region stood when this click happened, for a source
    /// that moves during the recording. A window capture follows the window
    /// wherever it is dragged, so a click after the drag must be projected
    /// through the window's position at that moment, not the one it had when
    /// the capture was prepared. `nil` means the recording's geometry applies.
    public let geometry: CaptureGeometry?
    /// Where the content sat in the frame at that moment; preferred over
    /// `geometry` when present, because it accounts for letterboxing.
    public let mapping: ContentMapping?
    /// The UI element under the click, when it could be looked up.
    public let element: CapturedElement?

    public init(
        nanoseconds: UInt64,
        screenX: Double,
        screenY: Double,
        button: String,
        clickCount: Int,
        modifiers: [String],
        geometry: CaptureGeometry? = nil,
        mapping: ContentMapping? = nil,
        element: CapturedElement? = nil
    ) {
        self.nanoseconds = nanoseconds
        self.screenX = screenX
        self.screenY = screenY
        self.button = button
        self.clickCount = clickCount
        self.modifiers = modifiers
        self.geometry = geometry
        self.mapping = mapping
        self.element = element
    }

    /// The same click with its element filled in, once the lookup finished.
    public func withElement(_ element: CapturedElement?) -> CapturedClick {
        return CapturedClick(
            nanoseconds: nanoseconds,
            screenX: screenX,
            screenY: screenY,
            button: button,
            clickCount: clickCount,
            modifiers: modifiers,
            geometry: geometry,
            mapping: mapping,
            element: element
        )
    }
}

/// A captured click placed on the recording's timeline and geometry.
public struct ProjectedClick: Equatable, Sendable {
    public let offsetMs: Int
    public let button: String
    public let clickCount: Int
    public let modifiers: [String]
    public let point: MappedClickPoint
    public let element: ProjectedElement?
}

/// Places captured clicks onto the recording.
///
/// The two ways a click can fail to land are deliberately not the same thing:
///
/// - A click that predates the first video frame is outside the recording
///   altogether — the tap starts before `SCStream` delivers its first sample —
///   so it is dropped without being counted.
/// - `droppedOutOfFrame` counts only clicks that happened during the recording
///   but landed outside the captured region. Recording one window and clicking
///   elsewhere means the click happened in an application the user never agreed
///   to record, so its position is not ours to keep; the count is what tells
///   downstream that activity happened at all.
public func projectClicks(
    _ clicks: [CapturedClick],
    timeline: ClickTimeline,
    geometry: CaptureGeometry,
    outputSize: OutputSize
) -> (clicks: [ProjectedClick], droppedOutOfFrame: Int) {
    var projected: [ProjectedClick] = []
    var droppedOutOfFrame = 0

    for click in clicks {
        guard let offsetMs = timeline.offsetMilliseconds(atNanoseconds: click.nanoseconds)
        else {
            continue
        }
        guard
            let point = click.mapping?.mapPoint(
                screenX: click.screenX,
                screenY: click.screenY,
                outputSize: outputSize
            )
                ?? (click.geometry ?? geometry).mapClick(
                    screenX: click.screenX,
                    screenY: click.screenY,
                    outputSize: outputSize
                )
        else {
            droppedOutOfFrame += 1
            continue
        }
        projected.append(
            ProjectedClick(
                offsetMs: offsetMs,
                button: click.button,
                clickCount: click.clickCount,
                modifiers: click.modifiers,
                point: point,
                element: click.element.flatMap {
                    projectElement(
                        $0,
                        mapping: click.mapping,
                        geometry: click.geometry ?? geometry,
                        outputSize: outputSize
                    )
                }
            )
        )
    }

    return (projected, droppedOutOfFrame)
}

/// Places `CGEvent` timestamps on the recording's timeline.
///
/// `CGEvent.timestamp` is nanoseconds since boot on the same host clock that
/// stamps the captured frames. It is not raw `mach_absolute_time` ticks: the
/// system has already applied the timebase. Applying it a second time here
/// multiplied every offset by 125/3 on Apple silicon, which reported a click
/// two seconds into a recording as 97 days into it, and looked fine on Intel
/// machines only because their ratio is 1/1.
public struct ClickTimeline: Equatable, Sendable {
    /// Host-clock time of the first captured frame, in nanoseconds.
    public let startNanoseconds: UInt64

    public init(startNanoseconds: UInt64) {
        self.startNanoseconds = startNanoseconds
    }

    /// Milliseconds from the start of the recording, or `nil` for an event that
    /// predates it.
    public func offsetMilliseconds(atNanoseconds nanoseconds: UInt64) -> Int? {
        guard nanoseconds >= startNanoseconds else {
            return nil
        }
        return Int((Double(nanoseconds - startNanoseconds) / 1_000_000).rounded())
    }
}

/// One pointer position observed while recording, in the plain values the
/// sampler captured: a click without the button facts.
public struct CapturedPointerSample: Equatable, Sendable {
    /// Host-clock nanoseconds, the same clock `CGEvent.timestamp` uses.
    public let nanoseconds: UInt64
    public let screenX: Double
    public let screenY: Double
    /// See `CapturedClick.geometry`.
    public let geometry: CaptureGeometry?
    /// See `CapturedClick.mapping`.
    public let mapping: ContentMapping?

    public init(
        nanoseconds: UInt64,
        screenX: Double,
        screenY: Double,
        geometry: CaptureGeometry? = nil,
        mapping: ContentMapping? = nil
    ) {
        self.nanoseconds = nanoseconds
        self.screenX = screenX
        self.screenY = screenY
        self.geometry = geometry
        self.mapping = mapping
    }
}

/// A pointer sample placed on the recording's timeline and geometry.
public struct ProjectedPointerSample: Equatable, Sendable {
    public let offsetMs: Int
    public let point: MappedClickPoint
}

/// Places pointer samples onto the recording.
///
/// Samples from before the first frame and samples outside the captured
/// region are dropped without being counted. A trail is only useful where the
/// video can show it, and unlike a click, a pointer resting outside the region
/// is not an event anyone downstream needs to hear about.
public func projectPointerSamples(
    _ samples: [CapturedPointerSample],
    timeline: ClickTimeline,
    geometry: CaptureGeometry,
    outputSize: OutputSize
) -> [ProjectedPointerSample] {
    return samples.compactMap { sample -> ProjectedPointerSample? in
        guard
            let offsetMs = timeline.offsetMilliseconds(atNanoseconds: sample.nanoseconds),
            let point = sample.mapping?.mapPoint(
                screenX: sample.screenX,
                screenY: sample.screenY,
                outputSize: outputSize
            )
                ?? (sample.geometry ?? geometry).mapClick(
                    screenX: sample.screenX,
                    screenY: sample.screenY,
                    outputSize: outputSize
                )
        else {
            return nil
        }
        return ProjectedPointerSample(offsetMs: offsetMs, point: point)
    }
}

/// Decides which pointer positions are worth keeping.
///
/// The sampler asks at a fixed rate, and a pointer that has not moved since
/// the last kept sample adds nothing but bytes to the track: a still pointer is
/// already described by the previous sample lasting longer. The first sample
/// is always kept.
public struct PointerTrailPolicy: Equatable, Sendable {
    public let minimumDistancePoints: Double

    public init(minimumDistancePoints: Double = 0.5) {
        self.minimumDistancePoints = minimumDistancePoints
    }

    public func shouldKeep(x: Double, y: Double, previous: CapturedPointerSample?) -> Bool {
        guard let previous else {
            return true
        }
        return abs(x - previous.screenX) >= minimumDistancePoints
            || abs(y - previous.screenY) >= minimumDistancePoints
    }
}

/// A stretch of keyboard activity, in milliseconds on the recording's timeline.
public struct TypingBurst: Equatable, Sendable {
    public let startMs: Int
    public let endMs: Int

    public init(startMs: Int, endMs: Int) {
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// Groups key-down moments into bursts.
///
/// Only *when* keys went down is known, never which keys: that is all a camera
/// needs to stay on the field being typed into, and it keeps the track from
/// being a record of what was typed. A gap longer than `gapMs` ends a burst; a
/// burst ends at its last key-down, so a single shortcut is a burst of length
/// zero that consumers can tell apart from real typing.
public func typingBursts(fromKeyDownOffsetsMs offsets: [Int], gapMs: Int = 800) -> [TypingBurst] {
    var bursts: [TypingBurst] = []
    for offset in offsets.sorted() {
        if let last = bursts.last, offset - last.endMs <= gapMs {
            bursts[bursts.count - 1] = TypingBurst(startMs: last.startMs, endMs: offset)
        } else {
            bursts.append(TypingBurst(startMs: offset, endMs: offset))
        }
    }
    return bursts
}

/// Where the captured content sits in both worlds: on screen, in global
/// points, and in the encoded frame, in pixels.
///
/// ScreenCaptureKit scales a window into the frame and, once the window's
/// aspect no longer matches the frame it was sized for, letterboxes it. The
/// frame's size then says nothing about where the content is: on a window
/// narrowed mid-recording, mapping through the frame size put every click 5%
/// too far right and 76 px too low. Every frame carries its content rectangle,
/// and mapping through that is exact.
public struct ContentMapping: Equatable, Sendable {
    public let screenOriginX: Double
    public let screenOriginY: Double
    public let screenWidth: Double
    public let screenHeight: Double
    public let pixelOriginX: Double
    public let pixelOriginY: Double
    public let pixelWidth: Double
    public let pixelHeight: Double

    public init(
        screenOriginX: Double,
        screenOriginY: Double,
        screenWidth: Double,
        screenHeight: Double,
        pixelOriginX: Double,
        pixelOriginY: Double,
        pixelWidth: Double,
        pixelHeight: Double
    ) {
        self.screenOriginX = screenOriginX
        self.screenOriginY = screenOriginY
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.pixelOriginX = pixelOriginX
        self.pixelOriginY = pixelOriginY
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    var isUsable: Bool {
        return screenWidth > 0 && screenHeight > 0 && pixelWidth > 0 && pixelHeight > 0
    }

    /// The frame pixel a screen point lands on, without checking bounds.
    func pixel(screenX: Double, screenY: Double) -> (x: Double, y: Double) {
        return (
            pixelOriginX + (screenX - screenOriginX) / screenWidth * pixelWidth,
            pixelOriginY + (screenY - screenOriginY) / screenHeight * pixelHeight
        )
    }

    /// Maps a global screen point into the frame, or `nil` when it is outside
    /// the captured content. `normalized` is the point as a fraction of the
    /// whole frame, which is what a camera multiplies by the video size.
    public func mapPoint(screenX: Double, screenY: Double, outputSize: OutputSize) -> MappedClickPoint? {
        guard isUsable else {
            return nil
        }
        let relativeX = (screenX - screenOriginX) / screenWidth
        let relativeY = (screenY - screenOriginY) / screenHeight
        guard relativeX >= 0, relativeX < 1, relativeY >= 0, relativeY < 1 else {
            return nil
        }
        let point = pixel(screenX: screenX, screenY: screenY)
        return MappedClickPoint(
            screenX: screenX,
            screenY: screenY,
            frameX: Int(point.x.rounded(.down)),
            frameY: Int(point.y.rounded(.down)),
            normalizedX: point.x / Double(outputSize.width),
            normalizedY: point.y / Double(outputSize.height)
        )
    }
}

/// The UI element a click landed on: what was hit, never what it contained.
public struct CapturedElement: Equatable, Sendable {
    public let role: String
    public let subrole: String?
    /// The element's frame in global screen points.
    public let screenX: Double
    public let screenY: Double
    public let screenWidth: Double
    public let screenHeight: Double

    public init(
        role: String,
        subrole: String?,
        screenX: Double,
        screenY: Double,
        screenWidth: Double,
        screenHeight: Double
    ) {
        self.role = role
        self.subrole = subrole
        self.screenX = screenX
        self.screenY = screenY
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
    }
}

/// An element's frame placed in the encoded frame, clipped to it.
public struct ProjectedElement: Equatable, Sendable {
    public let role: String
    public let subrole: String?
    public let frameX: Int
    public let frameY: Int
    public let frameWidth: Int
    public let frameHeight: Int
}

/// Places an element's screen frame into the encoded frame, through the
/// content mapping of the click's moment when there is one and the capture
/// geometry otherwise. Returns `nil` for an element entirely outside the frame.
public func projectElement(
    _ element: CapturedElement,
    mapping: ContentMapping?,
    geometry: CaptureGeometry,
    outputSize: OutputSize
) -> ProjectedElement? {
    func pixel(_ x: Double, _ y: Double) -> (x: Double, y: Double)? {
        if let mapping {
            guard mapping.isUsable else {
                return nil
            }
            return mapping.pixel(screenX: x, screenY: y)
        }
        guard geometry.widthPoints > 0, geometry.heightPoints > 0 else {
            return nil
        }
        return (
            (x - geometry.originX) / geometry.widthPoints * Double(outputSize.width),
            (y - geometry.originY) / geometry.heightPoints * Double(outputSize.height)
        )
    }
    guard
        let topLeft = pixel(element.screenX, element.screenY),
        let bottomRight = pixel(element.screenX + element.screenWidth, element.screenY + element.screenHeight)
    else {
        return nil
    }
    let left = max(0, topLeft.x)
    let top = max(0, topLeft.y)
    let right = min(Double(outputSize.width), bottomRight.x)
    let bottom = min(Double(outputSize.height), bottomRight.y)
    guard right - left >= 1, bottom - top >= 1 else {
        return nil
    }
    return ProjectedElement(
        role: element.role,
        subrole: element.subrole,
        frameX: Int(left.rounded(.down)),
        frameY: Int(top.rounded(.down)),
        frameWidth: Int((right - left).rounded()),
        frameHeight: Int((bottom - top).rounded())
    )
}
